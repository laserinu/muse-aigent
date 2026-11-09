// LIVE micro-test of V3SwapHelper on Robinhood Chain (4663).
// Leg 1 (buy): transfer 0.00001 WETH (1e13, already held) agent -> helper,
//   then helper.swapExactInputSingle(DELTA pool, WETH, DELTA, 1e13, spot x 0.90).
// Leg 2 (sell): transfer all DELTA received agent -> helper, then
//   helper.swapExactInputSingle(DELTA pool, DELTA, WETH, deltaAmount, spot x 0.90).
// NEVER more than 0.00001 WETH. If the buy leg fails: STOP, record the
// failure, do NOT retry blindly more than once. Writes microtest-result.json.
const fs = require("fs");
const { execSync } = require("child_process");
const {
  createPublicClient, http, parseAbi, encodeFunctionData,
} = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");

const DIR = "/home/hatch/workspace/tokens/sniper/v2/v3-helper";
const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const DELTA = "0xe8ffd7e24187f72afb08d75b1bb13088a989a791";
const POOL = "0xD64FbdA67E1015dF43Fa5e49F02cA844729E5F94";
const RPC = "https://rpc.mainnet.chain.robinhood.com";

const client = createPublicClient({ transport: http(RPC) });
const erc20Abi = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
const helperAbi = parseAbi([
  "function swapExactInputSingle(address pool, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMinimum) returns (uint256 amountOut)",
  "function owner() view returns (address)",
]);

function privyRpc(jsonObj) {
  execSync("bash /home/hatch/workspace/privy/restore-privy-machine-identity.sh", { stdio: "pipe" });
  const body = JSON.stringify(jsonObj);
  const out = execSync(
    `cd /home/hatch/workspace/privy/agent-cli && ./node_modules/.bin/privy-agent-wallet rpc --json '${body.replace(/'/g, "'\\''")}'`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function sendTx(to, data, value = "0x0") {
  const body = {
    method: "eth_sendTransaction",
    caip2: "eip155:4663",
    params: { transaction: { from: AGENT, to, value, data } },
  };
  const res = privyRpc(body);
  const hash = res?.data?.hash;
  if (!hash) throw new Error("Privy CLI did not return a tx hash: " + JSON.stringify(res).slice(0, 400));
  return hash;
}

async function waitReceipt(hash, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await client.getTransactionReceipt({ hash });
      if (r) return r;
    } catch (e) {
      if (!String(e.message).includes("TransactionReceiptNotFoundError") && !String(e.name).includes("TransactionReceiptNotFoundError")) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("waitReceipt timed out for " + hash);
}

async function balances(addr) {
  const [eth, weth, delta] = await Promise.all([
    client.getBalance({ address: addr }),
    client.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [addr] }),
    client.readContract({ address: DELTA, abi: erc20Abi, functionName: "balanceOf", args: [addr] }),
  ]);
  return { eth: eth.toString(), weth: weth.toString(), delta: delta.toString() };
}

// Exact spot output, BigInt only (same formula as v3.js / v3-trade.js).
function spotOut(amountIn, sqrtPriceX96, inputIsToken0) {
  const q = BigInt(sqrtPriceX96);
  const Q192 = 2n ** 192n;
  if (inputIsToken0) return (BigInt(amountIn) * q * q) / Q192;
  return (BigInt(amountIn) * Q192) / (q * q);
}

async function main() {
  const deploy = JSON.parse(fs.readFileSync(`${DIR}/deploy-result.json`, "utf8"));
  const HELPER = deploy.address;
  console.log("helper:", HELPER);
  const result = { helper: HELPER, pool: POOL, legs: {} };

  result.before = { agent: await balances(AGENT), helper: await balances(HELPER) };
  console.log("before agent:", JSON.stringify(result.before.agent));
  console.log("before helper:", JSON.stringify(result.before.helper));

  const AMOUNT_IN = 10000000000000n; // 0.00001 WETH — NEVER more.

  // ---- LEG 1: BUY DELTA with 1e13 WETH ----
  const slot0 = await client.readContract({ address: POOL, abi: poolAbi, functionName: "slot0" });
  const spotBuy = spotOut(AMOUNT_IN, slot0[0], true);
  const minOutBuy = (spotBuy * 90n) / 100n;
  console.log("buy: tick", slot0[1], "| spotOut", spotBuy.toString(), "| minOut x0.90", minOutBuy.toString());
  result.legs.buy = { tick: Number(slot0[1]), spotOut: spotBuy.toString(), minOut: minOutBuy.toString() };

  const fundData = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [HELPER, AMOUNT_IN] });
  const fundHash = sendTx(WETH, fundData);
  const fundRc = await waitReceipt(fundHash);
  console.log("buy fund tx:", fundHash, "| status:", fundRc.status, "| gas:", fundRc.gasUsed.toString());
  result.legs.buy.fundTx = fundHash;
  result.legs.buy.fundGas = fundRc.gasUsed.toString();
  result.legs.buy.fundStatus = fundRc.status;

  const swapData = encodeFunctionData({
    abi: helperAbi, functionName: "swapExactInputSingle",
    args: [POOL, WETH, DELTA, AMOUNT_IN, minOutBuy],
  });
  const buyHash = sendTx(HELPER, swapData);
  const buyRc = await waitReceipt(buyHash);
  console.log("buy swap tx:", buyHash, "| status:", buyRc.status, "| gas:", buyRc.gasUsed.toString());
  result.legs.buy.swapTx = buyHash;
  result.legs.buy.swapGas = buyRc.gasUsed.toString();
  result.legs.buy.swapStatus = buyRc.status;
  if (buyRc.status !== "success") throw new Error("BUY SWAP REVERTED onchain — stopping, no retry in this run");

  result.afterBuy = { agent: await balances(AGENT), helper: await balances(HELPER) };
  console.log("after buy agent:", JSON.stringify(result.afterBuy.agent));
  console.log("after buy helper:", JSON.stringify(result.afterBuy.helper));
  const deltaBought = BigInt(result.afterBuy.agent.delta);
  if (deltaBought <= 0n) throw new Error("buy succeeded but agent received 0 DELTA — stopping");
  console.log("DELTA bought:", deltaBought.toString());

  // ---- LEG 2: SELL the DELTA back for WETH ----
  const slot0b = await client.readContract({ address: POOL, abi: poolAbi, functionName: "slot0" });
  const spotSell = spotOut(deltaBought, slot0b[0], false);
  const minOutSell = (spotSell * 90n) / 100n;
  console.log("sell: tick", slot0b[1], "| spotOut", spotSell.toString(), "| minOut x0.90", minOutSell.toString());
  result.legs.sell = { tick: Number(slot0b[1]), spotOut: spotSell.toString(), minOut: minOutSell.toString(), amountIn: deltaBought.toString() };

  const fund2Data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [HELPER, deltaBought] });
  const fund2Hash = sendTx(DELTA, fund2Data);
  const fund2Rc = await waitReceipt(fund2Hash);
  console.log("sell fund tx:", fund2Hash, "| status:", fund2Rc.status, "| gas:", fund2Rc.gasUsed.toString());
  result.legs.sell.fundTx = fund2Hash;
  result.legs.sell.fundGas = fund2Rc.gasUsed.toString();
  result.legs.sell.fundStatus = fund2Rc.status;

  const swap2Data = encodeFunctionData({
    abi: helperAbi, functionName: "swapExactInputSingle",
    args: [POOL, DELTA, WETH, deltaBought, minOutSell],
  });
  const sellHash = sendTx(HELPER, swap2Data);
  const sellRc = await waitReceipt(sellHash);
  console.log("sell swap tx:", sellHash, "| status:", sellRc.status, "| gas:", sellRc.gasUsed.toString());
  result.legs.sell.swapTx = sellHash;
  result.legs.sell.swapGas = sellRc.gasUsed.toString();
  result.legs.sell.swapStatus = sellRc.status;
  if (sellRc.status !== "success") throw new Error("SELL SWAP REVERTED onchain");

  result.afterSell = { agent: await balances(AGENT), helper: await balances(HELPER) };
  console.log("after sell agent:", JSON.stringify(result.afterSell.agent));
  console.log("after sell helper:", JSON.stringify(result.afterSell.helper));
  result.verdict = "PROVEN — helper buys AND sells a V3 pool on Robinhood";
  fs.writeFileSync(`${DIR}/microtest-result.json`, JSON.stringify(result, null, 2));
  console.log("wrote microtest-result.json");
  console.log(result.verdict);
}

main().catch((e) => {
  console.error("MICRO-TEST FAILED:", e.message);
  try {
    const p = `${DIR}/microtest-result.json`;
    const prev = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
    prev.error = e.message;
    fs.writeFileSync(p, JSON.stringify(prev, null, 2));
  } catch {}
  process.exit(1);
});
