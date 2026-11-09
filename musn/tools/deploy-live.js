// MUSN live deploy executor — one chain at a time.
// Usage: node tools/deploy-live.js <base|polygon|arc|robinhood>
// Reads tools/deploy-<chain>.json (the verified preview output) and
// executes its txs in order via the Privy agent wallet.
//   Base/Arc/Robinhood: Privy eth_sendTransaction (Privy estimates gas).
//   Polygon: Privy eth_signTransaction + broadcast raw via public RPC
//     (Privy CLI broadcast fails on Polygon — proven sniper pattern).
//     NO gas-price ceiling here — the user waived the Polygon 10x rule
//     ("no more waiting now"); the 0.16 POL setAgentURI reserve floor
//     still applies to the balance check.
// Pre-flight (BEFORE any tx): native balance covers seed + estimated gas
//   (with a 5% margin) AND the MEV pre-init check passes (pool NOT
//   initialized — node tools/check-pool-init.js <chain> exits 0).
//   Polygon: if the agent already holds >= seedQuote WPOL, the wrap-weth
//   step is skipped (the seed uses the held WPOL).
// IDEMPOTENT / RESUMABLE: before estimating gas, each step's onchain
//   effect is checked (code exists / allowance set) and already-done steps
//   are skipped with a reason. Re-running the script after a crash resumes
//   from the first unfinished step — it never re-sends a tx whose outcome
//   is unknown (the onchain state is the source of truth).
// After the seed: verify token/collector/hook code, pool initialized with
//   liquidity, then burn the leftover MUSN dust to dead and verify the
//   agent's MUSN balance is 0. Writes tools/deploy-result-<chain>.json
//   incrementally (after each tx) so a crash never loses the record.
// Receipt waits are retried (Polygon's public RPC intermittently 403s on
//   eth_getTransactionReceipt — a retry a few seconds later succeeds).
// Exit 0 = deployed + verified. Exit 1 = skipped/failed (reason in the
//   result file + stdout). A failed tx stops the chain immediately.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters, encodeFunctionData } = require("viem");

const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const PRIVY_CWD = "/home/hatch/workspace/privy/agent-cli";
const RESTORE = "bash /home/hatch/workspace/privy/restore-privy-machine-identity.sh";

const CHAINS = {
  base: { chainId: 8453, rpc: "https://base-rpc.publicnode.com", native: "ETH" },
  polygon: { chainId: 137, rpc: "https://polygon-bor-rpc.publicnode.com", native: "POL" },
  arc: { chainId: 5042, rpc: "https://rpc.blockdaemon.mainnet.arc.io", native: "USDC" },
  robinhood: { chainId: 4663, rpc: "https://rpc.mainnet.chain.robinhood.com", native: "ETH" },
};

const EXTSLOAD_ABI = [
  { type: "function", name: "extsload", stateMutability: "view", inputs: [{ name: "slot", type: "bytes32" }], outputs: [{ name: "", type: "bytes32" }] },
];
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
];
const PERMIT2_ALLOWANCE_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
];

function hexBig(n) { return "0x" + BigInt(n).toString(16); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function privyRpc(jsonObj) {
  execSync(RESTORE, { stdio: "pipe" });
  const body = JSON.stringify(jsonObj);
  const out = execSync(
    `cd ${PRIVY_CWD} && ./node_modules/.bin/privy-agent-wallet rpc --json '${body.replace(/'/g, "'\\''")}'`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function sendTxPrivy(chainId, tx) {
  // The deploy JSON stores value as a DECIMAL string ("0", "118700000000000");
  // the Privy CLI requires a 0x-prefixed hex value.
  const valueHex = "0x" + BigInt(tx.value || "0").toString(16);
  const res = privyRpc({
    method: "eth_sendTransaction",
    caip2: `eip155:${chainId}`,
    params: { transaction: { from: AGENT, to: tx.to, value: valueHex, data: tx.data } },
  });
  const hash = res?.data?.hash;
  if (!hash) throw new Error("Privy eth_sendTransaction did not return a hash: " + JSON.stringify(res).slice(0, 300));
  return hash;
}

function signTxPrivy(chainId, tx, nonce, feeParams, gasLimit) {
  // Decimal-string value -> 0x hex (see sendTxPrivy).
  const valueHex = "0x" + BigInt(tx.value || "0").toString(16);
  const res = privyRpc({
    method: "eth_signTransaction",
    params: { transaction: {
      from: AGENT, to: tx.to, value: valueHex, data: tx.data,
      chain_id: chainId, nonce,
      gas_limit: hexBig(gasLimit),
      max_fee_per_gas: hexBig(feeParams.maxFeePerGas),
      max_priority_fee_per_gas: hexBig(feeParams.maxPriorityFeePerGas),
    } },
  });
  const d = res?.data;
  const raw = (d && (d.signed_transaction || d.rawTransaction || d.raw || d.signedTransaction)) || (typeof d === "string" ? d : null);
  if (!raw || typeof raw !== "string" || !raw.startsWith("0x")) {
    throw new Error("Privy eth_signTransaction did not return a raw tx: " + JSON.stringify(res).slice(0, 300));
  }
  return raw;
}

async function polygonFeeParams(client) {
  let baseFee;
  try {
    const fh = await client.getFeeHistory({ blockCount: 1, blockTag: "latest", rewardPercentiles: [25] });
    baseFee = BigInt(fh.baseFeePerGas[fh.baseFeePerGas.length - 1]);
  } catch {
    baseFee = await client.getGasPrice();
  }
  const maxFee = ((baseFee + 25000000000n) * 120n) / 100n;
  return { baseFee, maxFeePerGas: maxFee, maxPriorityFeePerGas: 25000000000n };
}

// Receipt wait with retries: Polygon's public RPC intermittently 403s on
// eth_getTransactionReceipt ("Archive requests require a personal token");
// a retry a few seconds later succeeds. Retries up to 5 times.
async function waitReceiptRobust(client, hash, label) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await client.waitForTransactionReceipt({ hash, timeout: 60000 });
      if (r) return r;
    } catch (e) {
      lastErr = e;
      console.log(`[receipt] ${label} attempt ${attempt}/5 failed (${String(e.message).slice(0, 100)}) — retrying in 10s`);
      await sleep(10000);
    }
  }
  throw new Error(`waitReceipt failed for ${label} ${hash} after 5 attempts: ${String(lastErr && lastErr.message ? lastErr.message : lastErr).slice(0, 300)}`);
}

// Amount encoded in an ERC20 approve calldata (0x095ea7b3 + spender + amount).
function approveAmount(data) { return BigInt("0x" + data.slice(74, 138)); }
// Amount encoded in a Permit2 approve calldata (0x87517c45 + token + spender + amount + expiration).
function permit2Amount(data) { return BigInt("0x" + data.slice(138, 202)); }

// Returns a skip reason if this step's onchain effect is already present,
// else null. Used for resume: the onchain state is the source of truth.
// Allowance reads are wrapped in try/catch: on a fresh chain the token
// isn't deployed yet, so the read returns no data — that just means the
// step is NOT done (return null), never a hard failure.
async function stepAlreadyDone(dj, client, tx) {
  const code = async (addr) => { const c = await client.getBytecode({ address: addr }); return c && c !== "0x"; };
  const allowanceOrNull = async (tokenAddr, owner, spender) => {
    try {
      return await client.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] });
    } catch { return null; }
  };
  const permit2AllowanceOrNull = async (tokenAddr, spender) => {
    try {
      const [amount] = await client.readContract({ address: PERMIT2, abi: PERMIT2_ALLOWANCE_ABI, functionName: "allowance", args: [AGENT, tokenAddr, spender] });
      return amount;
    } catch { return null; }
  };
  switch (tx.step) {
    case "deploy-token": return (await code(dj.token)) ? "token code already at preview address" : null;
    case "deploy-collector": return (await code(dj.collector)) ? "collector code already at preview address" : null;
    case "deploy-hook": return (await code(dj.hook)) ? "hook code already at preview address" : null;
    case "approve-musn-permit2": {
      const al = await allowanceOrNull(dj.token, AGENT, PERMIT2);
      return (al !== null && BigInt(al) >= approveAmount(tx.data)) ? "MUSN->Permit2 allowance already set" : null;
    }
    case "approve-quote-permit2": {
      const al = await allowanceOrNull(dj.quote, AGENT, PERMIT2);
      return (al !== null && BigInt(al) >= approveAmount(tx.data)) ? "quote->Permit2 allowance already set" : null;
    }
    case "permit2-approve-musn": {
      const amount = await permit2AllowanceOrNull(dj.token, dj.positionManager);
      return (amount !== null && BigInt(amount) >= permit2Amount(tx.data)) ? "Permit2 MUSN->PositionManager allowance already set" : null;
    }
    case "permit2-approve-quote": {
      const amount = await permit2AllowanceOrNull(dj.quote, dj.positionManager);
      return (amount !== null && BigInt(amount) >= permit2Amount(tx.data)) ? "Permit2 quote->PositionManager allowance already set" : null;
    }
    default: return null; // wrap-weth (handled by the WPOL check) and seed-multicall are never skipped here
  }
}

async function main() {
  const chainName = process.argv[2];
  const cfg = CHAINS[chainName];
  if (!cfg) { console.error("usage: node tools/deploy-live.js <base|polygon|arc|robinhood>"); process.exit(2); }
  const dir = __dirname;
  const dj = JSON.parse(fs.readFileSync(path.join(dir, "deploy-" + chainName + ".json"), "utf8"));
  const resultPath = path.join(dir, "deploy-result-" + chainName + ".json");
  const client = createPublicClient({ transport: http(cfg.rpc) });
  // Keep any already-recorded txs from a previous (interrupted) run.
  let result;
  try { result = JSON.parse(fs.readFileSync(resultPath, "utf8")); } catch { result = null; }
  if (!result || result.status === "skipped") {
    result = { chain: chainName, chainId: cfg.chainId, status: "started", startedAt: new Date().toISOString(), txs: [], verifications: {}, skippedReason: null, error: null };
  } else {
    result.status = "started";
    result.resumedAt = new Date().toISOString();
    result.error = null;
  }
  const save = () => fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));

  try {
    // ---------- Pre-flight ----------
    const balance = await client.getBalance({ address: AGENT });
    const gasPrice = await client.getGasPrice();
    result.preflight = { balanceWei: balance.toString(), gasPriceWei: gasPrice.toString(), gasPriceGwei: (Number(gasPrice) / 1e9).toFixed(3) };
    console.log(`[${chainName}] pre-flight: balance ${balance} wei, gasPrice ${result.preflight.gasPriceGwei} gwei`);

    // MEV pre-init check (must exit 0 = pool NOT initialized).
    try {
      execSync(`node ${path.join(dir, "check-pool-init.js")} ${chainName}`, { encoding: "utf8", stdio: "pipe" });
      console.log(`[${chainName}] MEV pre-init check: pool NOT initialized — safe to seed`);
    } catch (e) {
      throw new Error("MEV pre-init check FAILED — pool may already be initialized. STOP. Output: " + (e.stdout || e.message || "").slice(0, 400));
    }

    // Polygon: skip the wrap step if the agent already holds enough WPOL.
    let skipWrap = false;
    if (chainName === "polygon") {
      const wpolBal = await client.readContract({ address: dj.quote, abi: ERC20_ABI, functionName: "balanceOf", args: [AGENT] });
      result.preflight.wpolBalance = wpolBal.toString();
      console.log(`[${chainName}] WPOL balance ${wpolBal} (seed needs ${dj.seedQuote})`);
      if (BigInt(wpolBal) >= BigInt(dj.seedQuote)) { skipWrap = true; console.log(`[${chainName}] wrap-weth step SKIPPED — held WPOL covers the seed`); }
    }

    // Resume: mark already-done steps before estimating gas (so the
    // balance check only prices the remaining work).
    for (const tx of dj.txs) {
      if (skipWrap && tx.step === "wrap-weth") { tx._skip = true; tx._skipReason = "wrap skipped — held WPOL covers seed"; continue; }
      const done = await stepAlreadyDone(dj, client, tx);
      if (done) { tx._skip = true; tx._skipReason = "already done: " + done; console.log(`[${chainName}] ${tx.step} SKIPPED — ${done}`); }
    }

    // Estimate gas per remaining tx and check the balance covers
    // seed value + gas with a 5% margin.
    let estGasTotal = 0n;
    for (const tx of dj.txs) {
      if (tx._skip) continue;
      try {
        const est = await client.estimateGas({ account: AGENT, to: tx.to, data: tx.data, value: BigInt(tx.value || "0") });
        tx._gasEst = (est * 120n) / 100n; // 20% headroom
      } catch (e) {
        // The seed-multicall reverts under eth_estimateGas before the
        // approvals exist (same as the sniper's router execute). Use the
        // EVIDENCE-BASED estimate: the real seed used 440,267 gas (Base)
        // and 444,448 (Arc); 600,000 is actual + ~35% headroom. On the
        // Privy-send path this figure is only used for the balance check
        // (Privy estimates the real gas when sending); on the Polygon
        // sign path it is also the gas limit, and 600k covers the real
        // Polygon seed (530,153 gas) with headroom.
        if (tx.step === "seed-multicall") { tx._gasEst = 600000n; console.log(`[${chainName}] seed-multicall estimate failed (${String(e.message).slice(0, 80)}) — using evidence-based 600,000 estimate`); }
        else throw new Error(`gas estimation failed for ${tx.step}: ${String(e.message).slice(0, 200)}`);
      }
      estGasTotal += tx._gasEst;
    }
    const seedValue = dj.txs.reduce((s, t) => s + (t._skip ? 0n : BigInt(t.value || "0")), 0n);
    const estCost = seedValue + estGasTotal * gasPrice;
    result.preflight.estGasTotal = estGasTotal.toString();
    result.preflight.estTotalCostWei = estCost.toString();
    console.log(`[${chainName}] est gas ${estGasTotal}, est total cost ${estCost} wei vs balance ${balance} wei`);
    if (estCost * 105n / 100n > balance) {
      result.status = "skipped";
      result.skippedReason = `insufficient balance: seed + estimated gas ${estCost} wei (+5% margin) exceeds balance ${balance} wei`;
      save();
      console.log(`[${chainName}] SKIP — ${result.skippedReason}`);
      process.exit(1);
    }

    // ---------- Execute ----------
    let nonce = null;
    let feeParams = null;
    if (chainName === "polygon") {
      feeParams = await polygonFeeParams(client);
      nonce = await client.getTransactionCount({ address: AGENT, blockTag: "pending" });
      console.log(`[${chainName}] Polygon fee params: maxFee ${feeParams.maxFeePerGas} wei (${(Number(feeParams.maxFeePerGas) / 1e9).toFixed(1)} gwei), tip 25 gwei, nonce ${nonce}`);
    }
    let totalGasUsed = 0n;
    let totalGasPaid = 0n;
    // On resume, carry the gas already paid from the previous run.
    for (const t of result.txs) {
      if (t.gasUsed) totalGasUsed += BigInt(t.gasUsed);
      if (t.gasUsed && t.effectiveGasPriceWei) totalGasPaid += BigInt(t.gasUsed) * BigInt(t.effectiveGasPriceWei);
    }
    for (const tx of dj.txs) {
      if (tx._skip) {
        if (!result.txs.some((t) => t.step === tx.step && t.skipped)) {
          result.txs.push({ step: tx.step, skipped: true, reason: tx._skipReason });
          save();
        }
        continue;
      }
      let hash;
      if (chainName === "polygon") {
        const raw = signTxPrivy(cfg.chainId, tx, nonce, feeParams, tx._gasEst);
        hash = await client.sendRawTransaction({ serializedTransaction: raw });
        nonce += 1;
      } else {
        hash = sendTxPrivy(cfg.chainId, tx);
      }
      console.log(`[${chainName}] ${tx.step} sent: ${hash}`);
      const receipt = await waitReceiptRobust(client, hash, tx.step);
      if (receipt.status !== "success") throw new Error(`tx ${tx.step} FAILED: ${hash} status ${receipt.status}`);
      const gasUsed = receipt.gasUsed;
      const effPrice = receipt.effectiveGasPrice || gasPrice;
      totalGasUsed += gasUsed;
      totalGasPaid += gasUsed * effPrice;
      result.txs.push({ step: tx.step, hash, block: Number(receipt.blockNumber), gasUsed: gasUsed.toString(), effectiveGasPriceWei: effPrice.toString(), via: chainName === "polygon" ? "polygon-sign-broadcast" : "privy-send" });
      save();
      console.log(`[${chainName}] ${tx.step} confirmed block ${receipt.blockNumber} gasUsed ${gasUsed}`);
    }
    result.totalGasUsed = totalGasUsed.toString();
    result.totalGasPaidWei = totalGasPaid.toString();

    // ---------- Post-deploy verification ----------
    const code = async (addr) => await client.getBytecode({ address: addr });
    const tokenCode = await code(dj.token);
    const collectorCode = await code(dj.collector);
    const hookCode = await code(dj.hook);
    if (!tokenCode || tokenCode === "0x") throw new Error("token has NO code after deploy");
    if (!collectorCode || collectorCode === "0x") throw new Error("collector has NO code after deploy");
    if (!hookCode || hookCode === "0x") throw new Error("hook has NO code after deploy");
    result.verifications.tokenCode = true; result.verifications.collectorCode = true; result.verifications.hookCode = true;

    // Pool initialized? slot0 + liquidity via extsload.
    const token = dj.token.toLowerCase(); const quote = dj.quote.toLowerCase();
    const c0 = token < quote ? token : quote; const c1 = token < quote ? quote : token;
    const poolId = keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [c0, c1, 3000, 60, dj.hook]));
    const slot = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,uint256"), [poolId, 6n]));
    const liqSlot = "0x" + (BigInt(slot) + 3n).toString(16).padStart(64, "0");
    const slot0 = await client.readContract({ address: dj.poolManager, abi: EXTSLOAD_ABI, functionName: "extsload", args: [slot] });
    const liq = await client.readContract({ address: dj.poolManager, abi: EXTSLOAD_ABI, functionName: "extsload", args: [liqSlot] });
    result.verifications.poolId = poolId;
    result.verifications.poolSlot0 = slot0;
    result.verifications.poolLiquidity = liq;
    if (BigInt(slot0) === 0n || BigInt(liq) === 0n) throw new Error("pool NOT initialized after seed — slot0 or liquidity is zero");
    console.log(`[${chainName}] pool initialized: slot0 ${slot0.slice(0, 18)}... liquidity ${liq}`);

    // Dust burn: transfer the agent's leftover MUSN to dead, verify 0.
    const dust = await client.readContract({ address: dj.token, abi: ERC20_ABI, functionName: "balanceOf", args: [AGENT] });
    result.verifications.musnDustBeforeBurn = dust.toString();
    console.log(`[${chainName}] MUSN dust after seed: ${dust} raw`);
    if (BigInt(dust) > 0n) {
      const burnData = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [DEAD, BigInt(dust)] });
      const burnTx = { step: "burn-dust", to: dj.token, value: "0", data: burnData };
      let hash;
      if (chainName === "polygon") {
        const est = await client.estimateGas({ account: AGENT, to: burnTx.to, data: burnTx.data, value: 0n });
        const raw = signTxPrivy(cfg.chainId, burnTx, nonce, feeParams, (est * 120n) / 100n);
        hash = await client.sendRawTransaction({ serializedTransaction: raw });
      } else {
        hash = sendTxPrivy(cfg.chainId, burnTx);
      }
      const receipt = await waitReceiptRobust(client, hash, "burn-dust");
      if (receipt.status !== "success") throw new Error(`dust burn FAILED: ${hash} status ${receipt.status}`);
      const effPrice = receipt.effectiveGasPrice || gasPrice;
      totalGasUsed += receipt.gasUsed; totalGasPaid += receipt.gasUsed * effPrice;
      result.txs.push({ step: "burn-dust", hash, block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString(), effectiveGasPriceWei: effPrice.toString(), via: chainName === "polygon" ? "polygon-sign-broadcast" : "privy-send" });
      result.totalGasUsed = totalGasUsed.toString();
      result.totalGasPaidWei = totalGasPaid.toString();
      console.log(`[${chainName}] dust burn confirmed: ${hash} (${dust} raw MUSN -> dead)`);
    }
    const after = await client.readContract({ address: dj.token, abi: ERC20_ABI, functionName: "balanceOf", args: [AGENT] });
    result.verifications.musnBalanceAfterBurn = after.toString();
    if (BigInt(after) !== 0n) throw new Error("agent MUSN balance is not 0 after dust burn: " + after);
    console.log(`[${chainName}] agent MUSN balance after burn: 0 — deployer holds 0 MUSN`);

    result.status = "deployed";
    result.finishedAt = new Date().toISOString();
    save();
    console.log(`[${chainName}] DEPLOYED + VERIFIED. total gas ${totalGasUsed}, gas paid ${totalGasPaid} wei.`);
    process.exit(0);
  } catch (e) {
    result.status = result.status === "started" ? "failed" : result.status;
    result.error = String(e && e.message ? e.message : e).slice(0, 1000);
    result.finishedAt = new Date().toISOString();
    save();
    console.error(`[${chainName}] ${result.status.toUpperCase()}: ${result.error}`);
    process.exit(1);
  }
}

main();
