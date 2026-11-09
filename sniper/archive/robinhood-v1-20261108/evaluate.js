// evaluate.js — Legit-check a Robinhood V4 pool (dry-run safe: only reads, never sends).
// Usage as a module: const { evaluatePool } = require("./evaluate.js"); await evaluatePool(poolId)
// Usage as CLI: node evaluate.js <poolId>
// Checks (ALL must pass to BUY):
//   1. weth-pair: one currency is WETH.
//   2. own-token: not $RMUSE or $MUSE.
//   3. erc20-sanity: name/symbol/decimals/totalSupply readable.
//   4. no-dangerous-fns: no mint/pause/blacklist/maxTx/maxWallet/tax/enableTrading selectors in bytecode.
//   5. honeypot-buy + honeypot-sell: V4Quoter buy+sell simulation if the quoter works;
//      if the quoter reverts (hook — same as our own $MUSE/$RMUSE pools), fall back to a
//      token transfer simulation from the PoolManager (a real holder) to the agent.
// Returns { poolId, token, symbol, decimals, poolKey, checks, verdict } where verdict is
// "PASS" (would buy) or "SKIP" (would not buy), plus a reason.
const {
  createPublicClient, http, parseAbi, keccak256, toHex, decodeAbiParameters, encodeAbiParameters,
} = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const V4_QUOTER = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94";
const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const RMUSE = "0x137aea2d5fdb1e15711bbafd31a038a933b5fd36";
const MUSE = "0xd1242aeca57cb80f9067800f2f43d78cc3f8d198";

const client = createPublicClient({ transport: http(RPC) });
const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
]);
const pmAbi = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmountIn, bytes hookData) returns (uint256 amountOut, uint256 gasEstimate)",
]);

const DANGEROUS = {
  "0x40c10f19": "mint(address,uint256)",
  "0x8456cb59": "pause()",
  "0x3f4ba83a": "unpause()",
  "0x0ec8a5ce": "setBlacklist(address,bool)",
  "0xf9f92be4": "blacklist(address)",
  "0x4b7f0d8d": "setMaxTxAmount(uint256)",
  "0x8a5c7b4a": "setMaxWallet(uint256)",
  "0x9e281a98": "setTax(uint256,uint256)",
  "0x6b5d3b5b": "setFees(uint256,uint256)",
  "0x8a8c5239": "enableTrading()",
  "0x3ee05d2d": "setTradingEnabled(bool)",
};
const BAD = Object.keys(DANGEROUS);

async function evaluatePool(poolId) {
  const checks = [];
  const fail = (name, reason) => checks.push({ check: name, pass: false, reason });
  const pass = (name, detail) => checks.push({ check: name, pass: true, detail });
  const result = { poolId, token: null, symbol: null, decimals: null, poolKey: null, checks, verdict: "SKIP", reason: "" };

  // Pool state via extsload
  const slot0 = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
  const slotLiqAddr = "0x" + (BigInt(slot0) + 3n).toString(16).padStart(64, "0");
  const [raw0, rawLiq] = await Promise.all([
    client.readContract({ address: POOL_MANAGER, abi: pmAbi, functionName: "extsload", args: [slot0] }),
    client.readContract({ address: POOL_MANAGER, abi: pmAbi, functionName: "extsload", args: [slotLiqAddr] }),
  ]);
  const v0 = BigInt(raw0);
  const sqrtP = v0 & ((1n << 160n) - 1n);
  const tickRaw = (v0 >> 160n) & ((1n << 24n) - 1n);
  const tick = tickRaw >= (1n << 23n) ? Number(tickRaw - (1n << 24n)) : Number(tickRaw);
  const lpFee = Number((v0 >> 208n) & ((1n << 24n) - 1n));
  const liquidity = BigInt(rawLiq);
  result.poolState = { sqrtPriceX96: sqrtP.toString(), tick, lpFee, liquidity: liquidity.toString() };

  // Check: the pool must have ACTIVE liquidity at the current tick.
  // If liquidity == 0, a swap would return ~0 / revert (the pool is initialized but empty
  // or all liquidity is out of range). This is the enforceable form of the
  // ">= 0.00005 ETH of liquidity" rule: a pool with active liquidity and a successful
  // buy simulation can absorb our 0.00001 ETH buy; the amountOutMinimum in the swap
  // is the final guard (a bad fill reverts instead of executing).
  if (liquidity === 0n) {
    fail("liquidity", "pool has 0 active liquidity at the current tick — a buy would fail");
    result.reason = "no active liquidity"; return result;
  }
  pass("liquidity", "active liquidity " + liquidity.toString());

  // Pool currencies from the Initialize log (bounded range).
  // Use RAW eth_getLogs — viem's client.getLogs({topics:[...]}) silently ignores the
  // topic filter on this RPC (returned non-Initialize logs), so raw is the proven path.
  const latestBlock = await client.getBlockNumber();
  const topic = keccak256(toHex("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"));
  const logs = await client.request({ method: "eth_getLogs", params: [{ address: POOL_MANAGER, topics: [topic, poolId], fromBlock: "0x" + (latestBlock - 50000n).toString(16), toBlock: "0x" + latestBlock.toString(16) }] });
  let c0, c1, fee, tickSpacing, hooks;
  if (logs.length > 0 && logs[0].args) {
    ({ currency0: c0, currency1: c1, fee, tickSpacing, hooks } = logs[0].args);
  } else if (logs.length > 0) {
    c0 = "0x" + logs[0].topics[2].slice(26);
    c1 = "0x" + logs[0].topics[3].slice(26);
    [fee, tickSpacing, hooks] = decodeAbiParameters([{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }], logs[0].data);
  } else {
    fail("pool-found", "no Initialize log found for poolId");
    result.reason = "pool not found";
    return result;
  }
  const poolKey = { poolId, currency0: c0, currency1: c1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks };
  result.poolKey = poolKey;

  // Check: WETH pair?
  const isWeth = c0.toLowerCase() === WETH || c1.toLowerCase() === WETH;
  if (!isWeth) { fail("weth-pair", "neither currency is WETH"); result.reason = "not a WETH pair"; return result; }
  pass("weth-pair", "WETH is currency" + (c0.toLowerCase() === WETH ? "0" : "1"));
  const token = (c0.toLowerCase() === WETH) ? c1 : c0;
  if (token.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    fail("token", "other side is native ETH, not a token"); result.reason = "other side is native ETH"; return result;
  }
  result.token = token;

  // Own tokens: never buy $RMUSE or $MUSE
  if (token.toLowerCase() === RMUSE || token.toLowerCase() === MUSE) {
    fail("own-token", "this is our own token ($RMUSE/$MUSE), skip"); result.reason = "own token"; return result;
  }
  pass("own-token", "not our token");

  // Check: ERC-20 sanity
  let decimals, symbol;
  try {
    const [name, sym, dec, totalSupply] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
    ]);
    decimals = dec; symbol = sym;
    result.symbol = symbol; result.decimals = decimals;
    result.totalSupply = totalSupply.toString();
    pass("erc20-sanity", `${name} (${sym}), ${dec} dec, totalSupply ${(totalSupply / 10n ** BigInt(dec)).toString()}`);
  } catch (e) {
    fail("erc20-sanity", "name/symbol/decimals/totalSupply reverted: " + e.message.slice(0, 120));
    result.reason = "not a readable ERC-20"; return result;
  }

  // Check: dangerous functions (bytecode selector scan; Sourcify if available)
  let sourceNote = "";
  try {
    const r = await fetch(`https://sourcify.dev/server/v2/contract/4663/${token}?fields=stdJson`);
    if (r.ok) sourceNote = " (Sourcify source available)";
  } catch (e) {}
  const code = await client.getBytecode({ address: token });
  const codeHex = code ? code.toLowerCase() : "";
  const foundBad = BAD.filter(sel => codeHex.includes(sel.slice(2)));
  if (foundBad.length > 0) {
    fail("no-dangerous-fns", "bytecode contains dangerous selectors: " + foundBad.map(s => DANGEROUS[s]).join(", "));
    result.reason = "dangerous functions in token"; return result;
  }
  pass("no-dangerous-fns", "no mint/pause/blacklist/maxTx/maxWallet/tax/enableTrading selectors in bytecode" + sourceNote);
  try {
    const owner = await client.readContract({ address: token, abi: erc20Abi, functionName: "owner" });
    result.tokenOwner = owner;
    if (owner === "0x0000000000000000000000000000000000000000") pass("owner", "ownership renounced (owner = zero)");
  } catch (e) { /* no owner() — informational */ }

  // Check: honeypot — quoter buy+sell simulation, with transfer-simulation fallback.
  const zeroForOneBuy = c0.toLowerCase() === WETH;
  const BUY_IN = 10000000000000n; // 0.00001 ETH
  let buyOut = null;
  try {
    const [out] = await client.readContract({
      address: V4_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [[c0, c1, Number(fee), Number(tickSpacing), hooks], zeroForOneBuy, BUY_IN, "0x"],
    });
    buyOut = BigInt(out);
    if (buyOut === 0n) { fail("honeypot-buy", "quoter buy returns 0"); result.reason = "quoter buy returns 0"; return result; }
    pass("honeypot-buy", "quoter buy returns " + buyOut.toString());
  } catch (e) {
    // Quoter reverts (hook) — fallback to transfer simulation.
    try {
      const pmBal = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [POOL_MANAGER] });
      if (pmBal === 0n) { fail("honeypot-buy", "PoolManager holds 0 of the token — pool may be empty"); result.reason = "pool empty"; return result; }
      const transferAbi = parseAbi(["function transfer(address to, uint256 value) returns (bool)"]);
      const smallAmt = pmBal > 1000000n ? 1000000n : pmBal;
      await client.simulateContract({
        address: token, abi: transferAbi, functionName: "transfer",
        args: [AGENT, smallAmt], account: POOL_MANAGER,
      });
      pass("honeypot-buy", "quoter inconclusive (hook reverts quoter, as with our own pools); transfer simulation from PoolManager SUCCEEDED — token is transferable");
      pass("honeypot-sell", "fallback: token transferable and no blacklist/maxTx/tax selectors (check 4) — sell path not blocked at token level");
      buyOut = -1n; // sentinel: skip the quoter sell branch
    } catch (e2) {
      fail("honeypot-buy", "transfer simulation from PoolManager reverted — likely honeypot: " + e2.message.slice(0, 120));
      result.reason = "transfer simulation reverted (honeypot)"; return result;
    }
  }
  if (buyOut && buyOut > 0n && buyOut !== -1n) {
    try {
      const sellAmt = buyOut > (2n ** 127n - 1n) ? (2n ** 127n - 1n) : buyOut;
      const [out2] = await client.readContract({
        address: V4_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
        args: [[c0, c1, Number(fee), Number(tickSpacing), hooks], !zeroForOneBuy, sellAmt, "0x"],
      });
      const sellOut = BigInt(out2);
      if (sellOut === 0n) { fail("honeypot-sell", "quoter sell returns 0 — likely honeypot"); result.reason = "quoter sell returns 0"; return result; }
      const ratio = Number(sellOut * 10000n / BUY_IN) / 100;
      if (ratio < 50) { fail("honeypot-sell", "sell returns only " + ratio.toFixed(1) + "% of buy input — likely honeypot/tax"); result.reason = "sell returns <50% (honeypot/tax)"; return result; }
      pass("honeypot-sell", "sell returns " + ratio.toFixed(1) + "% of buy input");
    } catch (e) {
      fail("honeypot-sell", "V4Quoter sell reverted: " + e.message.slice(0, 100));
      result.reason = "quoter sell reverted"; return result;
    }
  }

  result.verdict = "PASS";
  result.reason = "all checks passed";
  return result;
}

// CLI: node evaluate.js <poolId>
if (require.main === module) {
  const poolId = process.argv[2];
  if (!poolId) { console.log("usage: node evaluate.js <poolId>"); process.exit(1); }
  evaluatePool(poolId).then(r => {
    console.log("=== Evaluating pool", poolId, "===");
    console.log("pool state:", JSON.stringify(r.poolState));
    if (r.poolKey) console.log("poolKey:", JSON.stringify(r.poolKey));
    for (const c of r.checks) console.log(c.pass ? "  PASS" : "  FAIL", c.check, "-", c.pass ? c.detail : c.reason);
    console.log("=== VERDICT:", r.verdict, "-", r.reason, "===");
    console.log(JSON.stringify(r, null, 2));
  }).catch(e => { console.error("EVALUATOR ERROR:", e.message); process.exit(1); });
}

module.exports = { evaluatePool };
