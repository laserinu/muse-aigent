// copy-trade-run.js — the copy-trader runner (Part 57, 2026-11-09).
//
// One cycle (intended cadence: every 2 min, same as the sniper):
//   1. Detect watchlist buys — GMGN feed first; onchain V4 Swap scan
//      only if GMGN is down.
//   2. For each new candidate: verify onchain (receipt from == maker,
//      net Transfer to maker) -> run the safety gates -> cap check ->
//      build the copy-buy. DRY-RUN by default: logs "would COPY-BUY"
//      and sends nothing. LIVE only when copy-trade-STATE.json live is
//      true AND --live is passed (the copy-trader's own gate, on top of
//      trade.js's live gate — the config is live for the sniper, so this
//      gate is the only thing stopping a copy-buy in dry-run).
//   3. After a LIVE buy, run the post-buy sell-route sim immediately.
//      A revert flags the position sellBlocked (debtdog lesson).
//   4. Manage open copy positions with the sniper's proven sell rules
//      (sell 50% at +100%, all at -50%). Mirror-exit (Part 59): a
//      verified sell by a watchlisted wallet of a token we hold sells
//      our FULL position; gated behind state.mirrorExit (default off),
//      SELL-SIGNAL-SKIP while off. Sells of tokens we do not hold are
//      noted-only.
//   5. Save state + append to copy-trade-LOG.md.
//
// CLI:
//   node copy-trade-run.js [--live] [--once] [--candidate <txHash>]
//   node copy-trade-run.js --onchain-only   (force the onchain scan)
//   node copy-trade-run.js --gmgn-only      (skip the onchain fallback)
// State lives in copy-trade-STATE.json (separate from v2/v3 state).

const fs = require("fs");
const path = require("path");
const { createPublicClient, http } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");
const trade = require("./trade.js");
const v3mod = require("./v3.js");
const ct = require("./copy-trade.js");
const sm = require("./smart-money.js");
const cfg = require("./config.json");

const STATE_PATH = path.join(__dirname, "copy-trade-STATE.json");
// Log path is overridable for tests (Part 60 hygiene fix): importing
// this runner makes log() append to the live LOG.md, and two earlier
// test runs polluted it. Tests run with COPY_TRADE_LOG_PATH set to a
// temp file; the live cron never sets it, so live behavior is unchanged.
const LOG_PATH = process.env.COPY_TRADE_LOG_PATH || path.join(__dirname, "copy-trade-LOG.md");
const CHAIN = { chainId: 4663, ...cfg.chains["4663"] };
const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const lc = (a) => (a || "").toLowerCase();

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return { version: 1, live: false, nativeEthLive: false, mirrorExit: false, cap: 5, copySnipesDone: 0, seenTxHashes: [], candidates: [], positions: [], sells: [], lastGmgnPoll: null, lastGmgnPollOk: null, lastOnchainScan: null }; }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n"); }
function log(line) {
  const ts = new Date().toISOString();
  const full = `[${ts}] ${line}`;
  console.log(full);
  fs.appendFileSync(LOG_PATH, full + "\n");
}

// Current price of a held token in quote units, from pool sqrtPriceX96.
// Same orientation as run.js priceQuotePerToken (V4) — the 2026-11-07
// inversion fix applies here too. V3 uses the same math with the pool's
// token0/token1 instead of the PoolKey's currency0/currency1.
function priceQuotePerToken(state, pos) {
  const sqrtP = BigInt(state.sqrtPriceX96);
  const c0 = pos.poolType === "v4" ? pos.poolKey.currency0 : pos.pool.token0;
  const dec0 = lc(c0) === lc(pos.quote.address) ? pos.quote.decimals : pos.decimals;
  const dec1 = lc(c0) === lc(pos.quote.address) ? pos.decimals : pos.quote.decimals;
  const spot = chains.priceFromSqrt(sqrtP, dec0, dec1); // token1 per token0
  return lc(c0) === lc(pos.quote.address) ? 1 / spot : spot;
}

// Build a candidate from a raw tx hash (onchain-scan path): the receipt's
// `from` is the wallet, and the token is the one the wallet net-received.
async function candidateFromReceipt(client, txHash, walletHint) {
  const rc = await client.getTransactionReceipt({ hash: txHash });
  if (!rc || rc.status !== "success") return null;
  const from = lc(rc.from);
  if (walletHint && from !== lc(walletHint)) return null;
  // Find the token the maker net-received (Transfer events, any token).
  const netByToken = {};
  for (const log of rc.logs || []) {
    if (lc(log.topics && log.topics[0]) !== TRANSFER_TOPIC0) continue;
    const token = lc(log.address);
    const fromAddr = "0x" + (log.topics[1] || "").slice(-40);
    const toAddr = "0x" + (log.topics[2] || "").slice(-40);
    const val = BigInt(log.data || "0x0");
    netByToken[token] = (netByToken[token] || 0n) + (lc(toAddr) === from ? val : 0n) - (lc(fromAddr) === from ? val : 0n);
  }
  let best = null;
  for (const [token, net] of Object.entries(netByToken)) {
    if (net > 0n && (!best || net > best.net)) best = { token, net };
  }
  if (!best) return null;
  let symbol = "?";
  try { symbol = await client.readContract({ address: best.token, abi: ct.ERC20_MIN_ABI, functionName: "symbol" }); } catch {}
  return { txHash: lc(txHash), wallet: from, token: best.token, symbol, amountUsd: 0, tokenAmount: 0, priceUsd: 0, makerBalanceAfter: 0, timestamp: 0, source: "onchain-v4-scan" };
}

// --- mirror-exit (sell signal, Part 59) --------------------------------
// A verified sell by a watchlisted wallet of a token we HOLD is a sell
// signal: sell our FULL copy position (current agent balance) via the
// proven sell builders. Sells of tokens we do not hold are noted-only.
// A signal ATTEMPTS the sell even on a sellBlocked position: the flag
// comes from simSellRoute, which false-positives on fresh positions
// (no token->Permit2 allowance yet — the native buy sets none, and the
// WETH buy approves the quote, not the token), so a real sell attempt
// is the only proof the hook really blocks. If the sell reverts, the
// position stays flagged sellBlocked and is not retried this run.
// Live-gated behind state.mirrorExit (default false); the runner logs
// SELL-SIGNAL-SKIP while it is off. In dry-run it logs
// "would MIRROR-SELL ALL" and sends nothing.
async function handleSellSignal(client, state, cand, verified, live) {
  const tag = `[${cand.symbol || "?"} ${cand.token.slice(0, 10)}...]`;
  const pos = (state.positions || []).find((p) => lc(p.token) === lc(cand.token) && !p.soldAll);
  if (!pos) {
    log(`${tag} SELL-SIGNAL noted: wallet ${verified.wallet.slice(0, 10)}... sold ${verified.netSentRaw.toString()} raw, but we hold no copy position in this token — no action.`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "sell-noted", reason: "no open copy position", netSentRaw: verified.netSentRaw.toString(), at: new Date().toISOString() });
    return "sell-noted";
  }
  log(`${tag} SELL-SIGNAL: wallet ${verified.wallet.slice(0, 10)}... sold ${verified.netSentRaw.toString()} raw of ${pos.symbol} (we hold a copy position${pos.sellBlocked ? ", flagged sellBlocked" : ""}).`);
  if (state.mirrorExit !== true) {
    log(`${tag} SELL-SIGNAL-SKIP: mirrorExit is off — no mirror sell (needs a separate go-live). Position kept; price-rule sells still apply.`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "sell-signal-skip", reason: "mirrorExit=false", at: new Date().toISOString() });
    return "sell-signal-skip";
  }
  // Fee sanity (Part 60): skip the mirror sell when the position's
  // pool fee is absurd (static > 5%) or dynamic (hook-set, unverifiable).
  // No build, no gas spent, position stays held; price-rule sells still
  // apply. Needs only the position record — no chain calls, so it runs
  // before balanceOf.
  const feeCheck = ct.checkPoolFeeSane(pos.pool && pos.pool.fee);
  if (!feeCheck.sane) {
    log(`${tag} FEE-SKIP: ${feeCheck.reason} — no mirror sell, position kept (no gas spent).`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "fee-skip", reason: feeCheck.reason, at: new Date().toISOString() });
    return "fee-skip";
  }
  // Full current balance — the whole position, not the maker's amount.
  let bal = 0n;
  try {
    bal = await client.readContract({ address: pos.token, abi: ct.ERC20_MIN_ABI, functionName: "balanceOf", args: [cfg.agent] });
  } catch (e) {
    log(`${tag} MIRROR-SELL ABORTED: balanceOf unreadable: ${e.message.slice(0, 100)}`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "sell-balance-error", reason: e.message.slice(0, 120), at: new Date().toISOString() });
    return "sell-balance-error";
  }
  if (bal === 0n) {
    log(`${tag} MIRROR-SELL ABORTED: agent balance is 0 — nothing to sell (position record is stale).`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "sell-empty", reason: "agent balance 0", at: new Date().toISOString() });
    return "sell-empty";
  }
  let built;
  try {
    built = await ct.buildCopySell(pos, bal);
  } catch (e) {
    log(`${tag} MIRROR-SELL BUILD FAILED: ${e.message.slice(0, 200)}`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "sell-build-failed", reason: e.message.slice(0, 120), at: new Date().toISOString() });
    return "sell-build-failed";
  }
  const fb = ct.feeBreakdown(pos);
  log(`${tag} MIRROR-SELL FEES: sell gas $${fb.sellGasUsd.toFixed(4)} (pool fee ${((pos.pool.fee || 0) / 1e4).toFixed(2)}% on proceeds). Selling ${bal.toString()} raw ${pos.symbol}.`);
  if (!live) {
    log(`${tag} would MIRROR-SELL ALL of ${pos.symbol}: ${bal.toString()} raw tokens (${built.kind}, minOut ${built.amountOutMinimum}) — DRY-RUN, nothing sent.`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "would-mirror-sell", poolType: pos.poolType, amountRaw: bal.toString(), amountOutMinimum: built.amountOutMinimum, at: new Date().toISOString() });
    return "would-mirror-sell";
  }
  try {
    const exec = await ct.executeMirrorSell(state, built, { liveConfirm: true });
    // Part 65 (2026-11-09): the mirror-sell sells the COMBINED wallet
    // balance, so it closes EVERY open record for this token — not just
    // the first one found (`pos`). The old code marked only `pos` sold,
    // leaving phantom "open" records (proven live twice on BANK: the
    // 13:28 UTC sell closed 1 of 4 records, the 13:31 sell again closed
    // only the oldest; 3 phantoms inflated the cap to 4/5 while only
    // Rocco was really held, and a legit copy was cap-skipped).
    const soldReason = `mirror-sell-all-${new Date().toISOString().slice(0, 10)}`;
    const closed = (state.positions || []).filter((p) => lc(p.token) === lc(cand.token) && !p.soldAll);
    for (const p of closed) { p.soldAll = true; p.soldReason = soldReason; }
    (state.sells = state.sells || []).push({ token: pos.token, symbol: pos.symbol, signalTxHash: cand.txHash, wallet: verified.wallet, sellTxHashes: exec.map((r) => r.hash), amountRaw: bal.toString(), amountOutMinimum: built.amountOutMinimum, reason: "mirror-exit", at: new Date().toISOString() });
    log(`${tag} MIRROR-SOLD ALL of ${pos.symbol}: ${bal.toString()} raw tokens (${closed.length} position record(s) closed). Txs: ${exec.map((r) => r.hash).join(", ")}`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "mirror-sold", poolType: pos.poolType, at: new Date().toISOString() });
    return "mirror-sold";
  } catch (e) {
    pos.sellBlocked = true;
    log(`${tag} MIRROR-SELL FAILED: ${e.message.slice(0, 200)} — position stays flagged sellBlocked, not retried this run.`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "mirror-sell-failed", reason: e.message.slice(0, 120), at: new Date().toISOString() });
    return "mirror-sell-failed";
  }
}

async function handleCandidate(client, state, cand, live) {
  const tag = `[${cand.symbol || "?"} ${cand.token.slice(0, 10)}...]`;
  // Verify onchain (receipt from == maker, net Transfer, pool, quote).
  const verified = await ct.verifyCandidate(client, CHAIN, cand);
  if (!verified.ok) {
    log(`${tag} REJECTED at verification: ${verified.reason} (tx ${cand.txHash.slice(0, 14)}..., wallet ${cand.wallet.slice(0, 10)}...)`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "rejected-verify", reason: verified.reason, at: new Date().toISOString() });
    return "rejected-verify";
  }
  // A verified SELL branches to the mirror-exit path (Part 59) — the
  // buy path below needs pool/quote/deployer fields a sell does not
  // carry (the pool comes from the held position, not the sell tx).
  if (verified.direction === "sell") {
    log(`${tag} VERIFIED SELL: wallet ${verified.wallet.slice(0, 10)}... sold ${verified.netSentRaw.toString()} raw of ${verified.symbol || cand.symbol} (tx ${cand.txHash.slice(0, 14)}...)`);
    return handleSellSignal(client, state, cand, verified, live);
  }
  log(`${tag} VERIFIED: wallet ${verified.wallet.slice(0, 10)}... bought on ${verified.poolType.toUpperCase()} pool (fee ${verified.pool.fee}, quote ${verified.quoteInfo.symbol}${verified.isNative ? " (NATIVE ETH)" : ""}, deployer ${(verified.deployer || "?").slice(0, 10)}...)`);
  // Part 65 (2026-11-09): ALREADY-HOLD — never buy more of a token we
  // already hold in an open copy position (proven live: BANK was copied
  // 5 times, incl. two buys 44s apart of a token already held). Runs
  // right after verification, before the API-gated work (GoPlus /
  // holders) and the build, so a skipped candidate costs only the
  // verification RPC calls. Unconditional: applies even when the held
  // position is sellBlocked — buying more of a token we may struggle
  // to exit is worse, not better. Sells are unaffected (they branch
  // above, before this check).
  const held = (state.positions || []).find((p) => lc(p.token) === lc(verified.token) && !p.soldAll);
  if (held) {
    log(`${tag} ALREADY-HOLD: we already hold an open copy position in ${verified.symbol} (bought ${held.at}) — no buy (no gas spent).`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "already-hold", reason: `open position since ${held.at}`, at: new Date().toISOString() });
    return "already-hold";
  }
  // Native-ETH pools are gated behind their own flag (Part 58) — the
  // path is built and dry-run proven, but it cannot fire live until a
  // separate go-live call flips state.nativeEthLive to true. Skip
  // before the gates: no gate API calls, no build, no buy.
  if (verified.isNative && state.nativeEthLive !== true) {
    log(`${tag} NATIVE-SKIP: native-ETH pool, nativeEthLive is off — no buy (needs a separate go-live). Token is ${verified.symbol}, pool fee ${verified.pool.fee}.`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "native-skip", reason: "nativeEthLive=false", at: new Date().toISOString() });
    return "native-skip";
  }
  // Safety gates.
  const gated = await ct.gateToken(client, CHAIN, verified);
  for (const c of gated.checks) {
    log(`${tag} gate ${c.name}: ${c.pass ? (c.warn ? "WARN" : "PASS") : "FAIL"} — ${c.detail}`);
  }
  if (!gated.pass) {
    const failed = gated.checks.filter((c) => !c.pass).map((c) => c.name).join(", ");
    log(`${tag} GATE-BLOCKED (${failed}) — NO BUY, no matter who bought it.`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "gate-blocked", reason: failed, at: new Date().toISOString() });
    return "gate-blocked";
  }
  // Cap (separate from v2/v3).
  const open = (state.positions || []).filter((p) => !p.soldAll).length;
  if (open >= (state.cap || 5)) {
    log(`${tag} CAP-SKIP: ${open}/${state.cap} copy positions open — no buy.`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "cap-skip", reason: `${open}/${state.cap} open`, at: new Date().toISOString() });
    return "cap-skip";
  }
  // Fee sanity (Part 60 buy side, 2026-11-09): skip the buy when the
  // pool fee is absurd (static > 5%) or dynamic (hook-set, unverifiable).
  // Mirrors the mirror-sell FEE-SKIP. No build, no gas spent.
  const feeCheck = ct.checkPoolFeeSane(verified.pool && verified.pool.fee);
  if (!feeCheck.sane) {
    log(`${tag} FEE-SKIP: ${feeCheck.reason} — no buy (no gas spent).`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "fee-skip", reason: feeCheck.reason, at: new Date().toISOString() });
    return "fee-skip";
  }
  // Build the buy (pure calldata — no send either way).
  let built;
  try {
    built = await ct.buildCopyBuy(verified, { nativeAllowed: state.nativeEthLive === true });
  } catch (e) {
    log(`${tag} BUY BUILD FAILED: ${e.message.slice(0, 200)}`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "build-failed", reason: e.message.slice(0, 120), at: new Date().toISOString() });
    return "build-failed";
  }
  // Fee accounting (measured gas) — always logged, live or dry-run.
  const fb = ct.feeBreakdown(verified, ct.COPY_BUY_USD);
  log(`${tag} FEES: buy gas $${fb.buyGasUsd.toFixed(4)} + sell gas $${fb.sellGasUsd.toFixed(4)} + LP $${fb.lpBuy.toFixed(5)} = round trip $${fb.totalFeesUsd.toFixed(4)}. Break-even ${fb.breakEvenMultiple.toFixed(2)}x. Net P&L: 1x $${fb.pnlAt1x.toFixed(4)}, 2x $${fb.pnlAt2x.toFixed(4)}, 3x $${fb.pnlAt3x.toFixed(4)}, 5x $${fb.pnlAt5x.toFixed(4)}.`);
  if (!live) {
    log(`${tag} would COPY-BUY $0.02 on ${verified.poolType.toUpperCase()} (amountIn ${built.amountIn}, minOut ${built.amountOutMinimum}) — DRY-RUN, nothing sent.`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "would-buy", poolType: verified.poolType, amountIn: built.amountIn, amountOutMinimum: built.amountOutMinimum, at: new Date().toISOString() });
    return "would-buy";
  }
  // LIVE: execute, then immediately sim the sell route.
  try {
    const exec = await ct.executeCopyBuy(state, built, { liveConfirm: true });
    const buyPrice = await currentPrice(client, verified);
    const pos = {
      token: verified.token, symbol: verified.symbol, decimals: verified.decimals,
      poolType: verified.poolType, pool: verified.pool, poolKey: verified.poolKey || null,
      poolId: verified.poolId || null, poolAddress: verified.poolAddress || null,
      quote: verified.quoteInfo, quoteInfo: verified.quoteInfo,
      wallet: verified.wallet, txHash: verified.txHash, buyTxHash: exec.map((r) => r.hash).join(","),
      buyPriceQuotePerToken: buyPrice, buyPriceSource: "post-buy-pool",
      amountInRaw: built.amountIn, amountOutMinimum: built.amountOutMinimum,
      soldHalf: false, soldAll: false, sellBlocked: false, at: new Date().toISOString(),
    };
    state.positions.push(pos);
    state.copySnipesDone = (state.copySnipesDone || 0) + 1;
    log(`${tag} BOUGHT $0.02 (copy of ${verified.wallet.slice(0, 10)}...). Txs: ${exec.map((r) => r.hash).join(", ")}`);
    // Post-buy sell-route sim (debtdog gap).
    const bal = await client.readContract({ address: verified.token, abi: ct.ERC20_MIN_ABI, functionName: "balanceOf", args: [cfg.agent] });
    if (bal > 0n) {
      const sim = await ct.simSellRoute(client, CHAIN, pos, bal);
      if (!sim.ok) {
        pos.sellBlocked = true;
        log(`${tag} SELL-ROUTE SIM FAILED after buy: ${sim.reason} — position flagged sellBlocked, do NOT buy more of this token.`);
      } else {
        log(`${tag} post-buy sell-route sim OK: ${sim.detail}`);
      }
    }
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "bought", poolType: verified.poolType, at: new Date().toISOString() });
    return "bought";
  } catch (e) {
    log(`${tag} LIVE BUY FAILED: ${e.message.slice(0, 200)}`);
    state.candidates.push({ txHash: cand.txHash, wallet: cand.wallet, token: cand.token, symbol: cand.symbol, outcome: "buy-failed", reason: e.message.slice(0, 120), at: new Date().toISOString() });
    return "buy-failed";
  }
}

async function currentPrice(client, pos) {
  if (pos.poolType === "v4") {
    const st = await chains.readPoolState(client, CHAIN.poolManager, pos.poolId || pos.pool.id);
    return priceQuotePerToken(st, pos);
  }
  const st = await v3mod.readV3PoolState(client, pos.poolAddress || pos.pool.pool);
  return priceQuotePerToken(st, pos);
}

async function managePositions(client, state, live) {
  for (const pos of state.positions || []) {
    if (pos.soldAll) continue;
    if (pos.sellBlocked) { log(`[position] ${pos.symbol}: sellBlocked — skipping sell checks (hook blocks our route).`); continue; }
    try {
      const cur = await currentPrice(client, pos);
      const change = (cur - pos.buyPriceQuotePerToken) / pos.buyPriceQuotePerToken;
      log(`[position] ${pos.symbol}: buy ${pos.buyPriceQuotePerToken} ${pos.quote.symbol}/token, current ${cur.toExponential(3)}, change ${(change * 100).toFixed(1)}%`);
      if (change >= (cfg.sellHalfAt ?? 1.0) && !pos.soldHalf) {
        if (live) {
          const bal = await client.readContract({ address: pos.token, abi: ct.ERC20_MIN_ABI, functionName: "balanceOf", args: [cfg.agent] });
          const half = bal / 2n;
          if (half > 0n) {
            const sell = await ct.buildCopySell(pos, half);
            const exec = await ct.executeCopySell(state, sell, { liveConfirm: true });
            pos.soldHalf = true;
            log(`[position] SOLD 50% of ${pos.symbol}: ${half.toString()} tokens. Txs: ${exec.map((r) => r.hash).join(", ")}`);
          }
        } else {
          log(`[position] would SELL 50% of ${pos.symbol} at +${(change * 100).toFixed(0)}% — DRY-RUN`);
        }
      } else if (change <= (cfg.sellAllAt ?? -0.5)) {
        if (live) {
          const bal = await client.readContract({ address: pos.token, abi: ct.ERC20_MIN_ABI, functionName: "balanceOf", args: [cfg.agent] });
          if (bal > 0n) {
            const sell = await ct.buildCopySell(pos, bal);
            const exec = await ct.executeCopySell(state, sell, { liveConfirm: true });
            pos.soldAll = true;
            log(`[position] SOLD ALL of ${pos.symbol}: ${bal.toString()} tokens at ${(change * 100).toFixed(0)}%. Txs: ${exec.map((r) => r.hash).join(", ")}`);
          }
        } else {
          log(`[position] would SELL ALL of ${pos.symbol} at ${(change * 100).toFixed(0)}% — DRY-RUN`);
        }
      }
    } catch (e) {
      log(`[position] ${pos.symbol} check failed: ${e.message.slice(0, 150)}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const wantLive = args.includes("--live");
  const onchainOnly = args.includes("--onchain-only");
  const gmgnOnly = args.includes("--gmgn-only");
  const candIdx = args.indexOf("--candidate");
  const singleCandidate = candIdx >= 0 ? args[candIdx + 1] : null;

  const state = loadState();
  const live = wantLive && state.live === true;
  if (wantLive && !state.live) {
    log("LIVE requested but copy-trade-STATE.json live is false — running DRY-RUN (nothing will send).");
  }
  log(`=== copy-trade run start (live=${live}, state.live=${state.live}, nativeEthLive=${state.nativeEthLive === true}, mirrorExit=${state.mirrorExit === true}) ===`);

  const client = chains.makeClient(CHAIN);
  const watchlist = sm.loadWatchlist();
  const watchSet = new Set((watchlist.wallets || watchlist || []).map((w) => lc(w.address || w)));
  const seen = new Set(state.seenTxHashes || []);
  log(`watchlist: ${watchSet.size} wallets`);

  if (singleCandidate) {
    // One-off verification of a known tx (used by the dry-run tests).
    const cand = await candidateFromReceipt(client, singleCandidate);
    if (!cand) { log(`--candidate ${singleCandidate}: no net-received token found (not a buy or not a watchlist wallet)`); }
    else if (!watchSet.has(cand.wallet)) { log(`--candidate ${singleCandidate}: from ${cand.wallet} is NOT on the watchlist — not a copy candidate`); }
    else {
      log(`--candidate ${singleCandidate}: watchlist wallet ${cand.wallet.slice(0, 10)}... bought ${cand.symbol} ${cand.token}`);
      await handleCandidate(client, state, cand, live);
    }
    state.seenTxHashes = [...seen].slice(-1000);
    saveState(state);
    log("=== copy-trade run end (single candidate) ===");
    return;
  }

  // 1. Detection — GMGN first.
  let candidates = [];
  if (!onchainOnly) {
    try {
      const feed = await ct.fetchGmgnFeed("robinhood", 100);
      state.lastGmgnPoll = new Date().toISOString();
      state.lastGmgnPollOk = true;
      log(`GMGN feed: ${feed.length} trades (newest ${feed.length ? Math.round((Date.now() - Number(feed[0].timestamp) * 1000) / 1000) + "s" : "?"} old)`);
      candidates = ct.detectCandidates(feed, watchSet, seen);
      log(`GMGN candidates: ${candidates.length} new watchlist buys`);
      // Mirror-exit (Part 59): watchlist sells are candidates too —
      // handleCandidate branches on verified direction; only sells of
      // tokens we HOLD act, the rest are noted-only.
      const sellCands = ct.detectSellCandidates(feed, watchSet, seen);
      if (sellCands.length) {
        log(`GMGN sell candidates: ${sellCands.length} new watchlist sells`);
        candidates.push(...sellCands);
      }
    } catch (e) {
      state.lastGmgnPollOk = false;
      log(`GMGN feed FAILED (${e.message.slice(0, 100)}) — falling back to the onchain V4 scan`);
    }
  }
  // 2. Onchain V4 scan fallback (GMGN down, or --onchain-only).
  if ((candidates.length === 0 && !state.lastGmgnPollOk && !gmgnOnly) || onchainOnly) {
    try {
      const latest = await client.getBlockNumber();
      const from = latest - 1200n; // ~2 min at ~10 blocks/s
      const scan = await ct.scanOnchainBuys(client, CHAIN, watchSet, from, latest);
      state.lastOnchainScan = new Date().toISOString();
      log(`onchain V4 scan: ${scan.logs} Swap logs / ${scan.txs} txs in [${from}, ${latest}] -> ${scan.hits.length} watchlist hits`);
      for (const hit of scan.hits) {
        if (seen.has(hit.txHash)) continue;
        const cand = await candidateFromReceipt(client, hit.txHash, hit.wallet);
        if (cand) candidates.push(cand);
      }
    } catch (e) {
      log(`onchain V4 scan FAILED: ${e.message.slice(0, 150)}`);
    }
  }

  for (const cand of candidates) {
    seen.add(cand.txHash);
    try { await handleCandidate(client, state, cand, live); }
    catch (e) { log(`candidate ${cand.txHash.slice(0, 14)}... error: ${e.message.slice(0, 150)}`); }
  }

  // 3. Position management (sell rules).
  await managePositions(client, state, live);

  state.seenTxHashes = [...seen].slice(-1000);
  saveState(state);
  log("=== copy-trade run end ===");
}

if (require.main === module) {
  main().catch((e) => { console.error("COPY-TRADE RUNNER ERROR:", e); process.exit(1); });
}

module.exports = { handleCandidate, handleSellSignal, candidateFromReceipt, priceQuotePerToken, loadState, saveState };
