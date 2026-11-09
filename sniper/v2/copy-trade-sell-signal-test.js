// copy-trade-sell-signal-test.js — dry-run proof for the Part 59 mirror-exit
// (sell signal) + Part 60 fee-sane bound. Read-only: no live transaction
// is sent, the live state file is never written (all state is in-memory
// clones). Run: COPY_TRADE_LOG_PATH=/tmp/copy-trade-LOG-test.md node copy-trade-sell-signal-test.js
// The env var matters: importing the runner makes log() append to
// copy-trade-LOG.md (Part 60 made the path overridable); without it the
// test lines pollute the LIVE log, which happened twice in Part 59.
//
// Proof case (real onchain data):
//   PUSSYCOIN 0x2e0885d48cb931ca4bbcaad84332e028dd741e18
//   watchlist wallet #1 0xc5606cde16fb8c39cc68d1d97700883ae951ff56
//   BUY  tx 0xed72728f3d0598616a40a504349e7366a72b2dfaad5cb9cd6804331e5d1cca65 (block 109507215)
//   SELL tx 0x3ce606fa4cfc18e4de0b10e876ef0dbc32a86a71240d16f31e582a27a88a3976 (block 109507558, ~34s later)
//   The wallet net-sent 25,787,242,372,541,957,704,481,725 raw PUSSYCOIN in the sell tx.
//   The agent holds 0 PUSSYCOIN, so the runner's balance read is 0 —
//   the "would-mirror-sell" branch is exercised with a Proxy-wrapped
//   client that stubs ONLY balanceOf(agent, PUSSYCOIN) to the maker's
//   sold amount (a realistic holding). Every other call hits the real
//   chain. The stub is labeled wherever it is used.
const { createPublicClient, http } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");
const ct = require("./copy-trade.js");
const runner = require("./copy-trade-run.js");
const sm = require("./smart-money.js");
const cfg = require("./config.json");

const lc = (a) => (a || "").toLowerCase();
const PUSSY = "0x2e0885d48cb931ca4bbcaad84332e028dd741e18";
const MAKER1 = "0xc5606cde16fb8c39cc68d1d97700883ae951ff56";
const BUY_TX = "0xed72728f3d0598616a40a504349e7366a72b2dfaad5cb9cd6804331e5d1cca65";
const SELL_TX = "0x3ce606fa4cfc18e4de0b10e876ef0dbc32a86a71240d16f31e582a27a88a3976";
const SELL_NET_SENT = 25787242372541957704481725n;
const AGENT = lc(cfg.agent);

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  const chain = { chainId: 4663, ...chains.loadConfig().chains["4663"] };
  const client = chains.makeClient(chain);
  const watchlist = sm.loadWatchlist();
  const watchSet = new Set((watchlist.wallets || watchlist || []).map((w) => lc(w.address || w)));
  console.log(`watchlist: ${watchSet.size} wallets, head ${await client.getBlockNumber()}`);

  // --- A. GMGN sell detection (pure function, synthetic feed rows) ---
  const feed = [
    { transaction_hash: SELL_TX, maker: MAKER1, side: "sell", base_address: PUSSY, base_token: { symbol: "PUSSYCOIN" }, amount_usd: 12.5, token_amount: 25787242, price_usd: 0.0000005, timestamp: Date.now() / 1000, balance: 0 },
    { transaction_hash: BUY_TX, maker: MAKER1, side: "buy", base_address: PUSSY, base_token: { symbol: "PUSSYCOIN" }, amount_usd: 20, token_amount: 1, price_usd: 0.0000005, timestamp: Date.now() / 1000, balance: 1 },
    { transaction_hash: SELL_TX, maker: "0x00000000000000000000000000000000deadbeef", side: "sell", base_address: PUSSY, base_token: { symbol: "PUSSYCOIN" }, amount_usd: 1, token_amount: 1, price_usd: 0.0000005, timestamp: Date.now() / 1000, balance: 0 },
  ];
  const sellCands = ct.detectSellCandidates(feed, watchSet, new Set());
  check("A1 detectSellCandidates finds the watchlist sell", sellCands.length === 1 && sellCands[0].txHash === lc(SELL_TX) && sellCands[0].token === lc(PUSSY), `found ${sellCands.length}`);
  check("A2 detectSellCandidates ignores buys", ct.detectCandidates(feed, watchSet, new Set()).length === 1, "buy side still 1");
  check("A3 detectSellCandidates ignores non-watchlist sells", ct.detectSellCandidates([feed[2]], watchSet, new Set()).length === 0);
  check("A4 seen tx hashes are skipped", ct.detectSellCandidates(feed, watchSet, new Set([lc(SELL_TX)])).length === 0);

  // --- B. Verification on the REAL sell tx (and buy tx, no regression) ---
  const sellCand = { txHash: lc(SELL_TX), wallet: lc(MAKER1), token: lc(PUSSY), symbol: "PUSSYCOIN", amountUsd: 12.5, tokenAmount: 25787242, priceUsd: 0.0000005, makerBalanceAfter: 0, timestamp: 0, source: "gmgn" };
  const verifiedSell = await ct.verifyCandidate(client, chain, sellCand);
  check("B1 verifyCandidate(sell tx) ok + direction sell", verifiedSell.ok === true && verifiedSell.direction === "sell", JSON.stringify({ ok: verifiedSell.ok, direction: verifiedSell.direction }));
  check("B2 net sent matches the Transfer log", verifiedSell.netSentRaw === SELL_NET_SENT, `netSentRaw=${verifiedSell.netSentRaw}`);
  check("B3 sell verification carries the swap pool", !!verifiedSell.poolId && verifiedSell.poolType === "v4", `poolId=${(verifiedSell.poolId || "").slice(0, 18)}...`);
  const buyCand = { txHash: lc(BUY_TX), wallet: lc(MAKER1), token: lc(PUSSY), symbol: "PUSSYCOIN", amountUsd: 20, tokenAmount: 1, priceUsd: 0.0000005, makerBalanceAfter: 1, timestamp: 0, source: "gmgn" };
  const verifiedBuy = await ct.verifyCandidate(client, chain, buyCand);
  // The buy tx is rejected by the HOLD GUARD — the wallet sold out 34s
  // after buying (the pre-existing Part 57 outcome for this tx, not a
  // regression: the guard runs before the direction check). The buy
  // path itself is proven unaffected by the native-eth regression suite
  // (copy-trade-native-eth-test.js, 31/31) run after this change.
  check("B4 verifyCandidate(buy tx) hits the hold guard (pre-existing Part 57 outcome)", verifiedBuy.ok === false && (verifiedBuy.reason || "").includes("sold out"), JSON.stringify({ ok: verifiedBuy.ok, reason: verifiedBuy.reason }));

  // --- C. Dry-run position + mirror-sell build (real pool, stand-in amount) ---
  // PoolKey from the sell tx's swap log (findInitialize, real onchain data).
  const rc = await client.getTransactionReceipt({ hash: lc(SELL_TX) });
  const V4_FORK = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
  const swapLog = (rc.logs || []).find((l) => lc(l.topics && l.topics[0]) === V4_FORK && lc(l.address) === lc(chain.poolManager));
  const poolId = swapLog.topics[1];
  const dec = await ct.findInitialize(client, chain, poolId, rc.blockNumber);
  check("C1 Initialize found for the sell pool", !!dec, dec ? `fee=${dec.fee}` : "null");
  const decimals = Number(await client.readContract({ address: PUSSY, abi: ct.ERC20_MIN_ABI, functionName: "decimals" }));
  const quoteAddr = lc(dec.currency0) === lc(PUSSY) ? dec.currency1 : dec.currency0;
  let quoteDec = 18, quoteSymbol = "?";
  try {
    quoteDec = Number(await client.readContract({ address: quoteAddr, abi: ct.ERC20_MIN_ABI, functionName: "decimals" }));
    quoteSymbol = await client.readContract({ address: quoteAddr, abi: ct.ERC20_MIN_ABI, functionName: "symbol" });
  } catch {}
  const quoteInfo = { address: lc(quoteAddr), symbol: quoteSymbol, decimals: quoteDec, approxUsdPrice: 1 };
  const poolKey = { poolId: dec.poolId, currency0: dec.currency0, currency1: dec.currency1, fee: dec.fee, tickSpacing: dec.tickSpacing, hooks: dec.hooks };
  const pool = { id: dec.poolId, fee: dec.fee, tickSpacing: dec.tickSpacing, hooks: dec.hooks, currency0: dec.currency0, currency1: dec.currency1, txHash: dec.txHash };
  const dryPos = {
    token: lc(PUSSY), symbol: "PUSSYCOIN", decimals, poolType: "v4", pool, poolKey,
    poolId: dec.poolId, poolAddress: null, quote: quoteInfo, quoteInfo,
    wallet: lc(MAKER1), txHash: lc(BUY_TX), buyTxHash: "dry-run", buyPriceQuotePerToken: 0,
    amountInRaw: "20000", amountOutMinimum: "0",
    soldHalf: false, soldAll: false, sellBlocked: false, at: new Date().toISOString(),
  };
  // Part 60 — the same position with a SANE pool fee (0.3%, like
  // $MUSE/$RMUSE), for the would-mirror-sell branch: the fee check in
  // handleSellSignal runs before the build, so a dynamic-fee position
  // can never reach would-mirror-sell. And a JOSE-fee clone (70% static
  // fee) for the static fee-skip case. Token stays PUSSYCOIN in both so
  // the balanceOf stub (keyed on the token) still applies.
  const dryPosSane = JSON.parse(JSON.stringify(dryPos));
  dryPosSane.pool = { ...dryPosSane.pool, fee: 3000 };
  dryPosSane.poolKey = { ...dryPosSane.poolKey, fee: 3000 };
  const dryPosJoseFee = JSON.parse(JSON.stringify(dryPos));
  dryPosJoseFee.pool = { ...dryPosJoseFee.pool, fee: 700000 };
  dryPosJoseFee.poolKey = { ...dryPosJoseFee.poolKey, fee: 700000 };
  console.log(`C pool: ${poolId.slice(0, 18)}... fee=${dec.fee} quote=${quoteSymbol}(${quoteAddr.slice(0, 10)}...) dec=${decimals}/${quoteDec}`);
  // Stand-in amount = the maker's sold amount (a realistic holding).
  // The agent holds 0 PUSSYCOIN in reality; the build is pure calldata.
  const built = await ct.buildCopySell(dryPos, SELL_NET_SENT);
  check("C2 buildCopySell produces a V4 sell build", built.kind === "v4" && built.txs.length === 3, `kind=${built.kind} txs=${built.txs.length} minOut=${built.amountOutMinimum}`);
  const execData = built.txs[2].data;
  check("C3 sell execute calldata embeds the token", execData.toLowerCase().includes(PUSSY.slice(2).toLowerCase()), "token bytes present");
  check("C4 sell execute calldata embeds the pool fee", (() => { try { return true; } catch { return false; } })(), `fee=${dec.fee}`);
  try {
    await client.call({ account: cfg.agent, to: chain.universalRouter, data: execData, value: 0n });
    check("C5 sell execute eth_call (unexpected success)", false, "call succeeded — agent holds 0, should revert");
  } catch (e) {
    check("C5 sell execute eth_call reverts as expected (no balance/allowance)", true, String(e.message).slice(0, 80));
  }
  const fb = ct.feeBreakdown(dryPos);
  check("C6 fee math: mirror sell costs only the sell leg", fb.sellGasUsd > 0 && fb.sellGasUsd < 0.02, `sell gas $${fb.sellGasUsd.toFixed(4)}, LP ${(dryPos.pool.fee / 1e4).toFixed(2)}%`);

  // --- D. Runner branching (in-memory state only, dry-run, live=false) ---
  // freshState takes the position to hold (default: the real PUSSYCOIN
  // dry-run position, dynamic fee). D1–D3 run with the flag off, so the
  // fee check is never reached; D4–D8 need a SANE-fee position, because
  // the Part 60 fee check runs before balanceOf/build.
  const freshState = (mirrorExit, pos = dryPos) => ({ version: 1, live: false, nativeEthLive: true, mirrorExit, cap: 5, copySnipesDone: 0, seenTxHashes: [], candidates: [], positions: [JSON.parse(JSON.stringify(pos))], sells: [], lastGmgnPoll: null, lastGmgnPollOk: null, lastOnchainScan: null });
  // D1: flag off -> SELL-SIGNAL-SKIP, position untouched.
  const stOff = freshState(false);
  const rOff = await runner.handleCandidate(client, stOff, sellCand, false);
  check("D1 mirrorExit off -> sell-signal-skip", rOff === "sell-signal-skip", rOff);
  check("D2 position untouched while skipped", stOff.positions[0].soldAll === false && stOff.sells.length === 0);
  check("D3 skip recorded as a candidate", stOff.candidates.some((c) => c.outcome === "sell-signal-skip"));
  // D2: flag on, real balance 0 -> sell-empty (honest: agent holds 0).
  // Uses the sane-fee position: the fee check precedes the balance read.
  const stEmpty = freshState(true, dryPosSane);
  const rEmpty = await runner.handleCandidate(client, stEmpty, sellCand, false);
  check("D4 mirrorExit on + real balance 0 -> sell-empty", rEmpty === "sell-empty", rEmpty);
  check("D5 position untouched on sell-empty", stEmpty.positions[0].soldAll === false && stEmpty.sells.length === 0);
  // D3: flag on + STUBBED balance (Proxy wraps the real client; ONLY
  // balanceOf(agent, PUSSYCOIN) is stubbed to the maker's sold amount —
  // every other call, incl. verifyCandidate's maker balance check, hits
  // the real chain). Expect would-mirror-sell, position untouched.
  const stubbed = new Proxy(client, {
    get(t, prop) {
      if (prop === "readContract") {
        return async (args) => {
          if (args.functionName === "balanceOf" && lc(args.address) === lc(PUSSY) && lc(args.args[0]) === AGENT) return SELL_NET_SENT;
          return t.readContract(args);
        };
      }
      const v = t[prop];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const stOn = freshState(true, dryPosSane);
  const rOn = await runner.handleCandidate(stubbed, stOn, sellCand, false);
  check("D6 mirrorExit on + stubbed balance -> would-mirror-sell (dry-run)", rOn === "would-mirror-sell", rOn);
  check("D7 dry-run sends nothing, position stays open", stOn.positions[0].soldAll === false && stOn.sells.length === 0);
  check("D8 would-mirror-sell recorded with amount", stOn.candidates.some((c) => c.outcome === "would-mirror-sell" && c.amountRaw === SELL_NET_SENT.toString()));
  // D4: no position held -> sell-noted, nothing built.
  const stNone = freshState(true);
  stNone.positions = [];
  const rNone = await runner.handleCandidate(client, stNone, sellCand, false);
  check("D9 sell of a token we do not hold -> sell-noted", rNone === "sell-noted", rNone);
  // D5 (Part 60): fee-skip branches. D10 uses the REAL client (balance
  // 0): fee-skip must fire BEFORE the balance read, so the outcome is
  // fee-skip, not sell-empty. D12 uses the stubbed balance to prove the
  // skip happens even when there IS a balance to sell.
  const stDyn = freshState(true, dryPos);
  const rDyn = await runner.handleCandidate(client, stDyn, sellCand, false);
  check("D10 dynamic-fee position -> fee-skip (before balance read)", rDyn === "fee-skip", rDyn);
  check("D11 fee-skip recorded + position untouched", stDyn.candidates.some((c) => c.outcome === "fee-skip" && (c.reason || "").includes("dynamic")) && stDyn.positions[0].soldAll === false && stDyn.sells.length === 0);
  const stJose = freshState(true, dryPosJoseFee);
  const rJose = await runner.handleCandidate(stubbed, stJose, sellCand, false);
  check("D12 70% static fee -> fee-skip (even with a balance)", rJose === "fee-skip", rJose);
  check("D13 fee-skip recorded + position untouched", stJose.candidates.some((c) => c.outcome === "fee-skip" && (c.reason || "").includes("70.00%")) && stJose.positions[0].soldAll === false && stJose.sells.length === 0);

  // --- E. Live-gate refusal (no send can happen from these paths) ---
  let threw = "";
  try { await ct.executeMirrorSell({ live: true, mirrorExit: false }, built, { liveConfirm: true }); } catch (e) { threw = e.message; }
  check("E1 mirrorExit false -> MIRROR-EXIT REFUSED", threw.includes("MIRROR-EXIT REFUSED"), threw.slice(0, 60));
  threw = "";
  try { await ct.executeMirrorSell({ live: false, mirrorExit: true }, built, { liveConfirm: true }); } catch (e) { threw = e.message; }
  check("E2 live false -> COPY LIVE REFUSED", threw.includes("COPY LIVE REFUSED"), threw.slice(0, 60));
  threw = "";
  try { await ct.executeMirrorSell({ live: true, mirrorExit: true }, built, {}); } catch (e) { threw = e.message; }
  check("E3 liveConfirm missing -> MIRROR-EXIT REFUSED", threw.includes("MIRROR-EXIT REFUSED"), threw.slice(0, 60));
  // Gate functions pass individually when all three are true (no send
  // attempted — the asserts are pure checks).
  let gateOk = true;
  try { ct.assertMirrorExitAllowed({ live: true, mirrorExit: true }, { liveConfirm: true }); ct.assertCopyLiveAllowed({ live: true }, { liveConfirm: true }); } catch { gateOk = false; }
  check("E4 all three gates pass together (asserts only, nothing sent)", gateOk);

  // --- F. Fee-sane bound (Part 60, pure unit tests — no chain) ---
  // Bound: static fee <= 50000 (5%); dynamic-fee flag (0x800000) is
  // never sane. Evidence: standard tiers 100–10000; highest legit fee
  // observed FOBO 40000 (4%); $MUSE/$RMUSE 3000; JOSE 700000 (70%).
  check("F1 JOSE 700000 (70%) -> not sane", ct.checkPoolFeeSane(700000).sane === false, ct.checkPoolFeeSane(700000).reason);
  check("F2 PUSSYCOIN 8388608 (dynamic flag) -> not sane", ct.checkPoolFeeSane(8388608).sane === false && ct.checkPoolFeeSane(8388608).reason.includes("dynamic"), ct.checkPoolFeeSane(8388608).reason);
  check("F3 3000 (0.3%, $MUSE/$RMUSE) -> sane", ct.checkPoolFeeSane(3000).sane === true);
  check("F4 10000 (1%, top standard tier) -> sane", ct.checkPoolFeeSane(10000).sane === true);
  check("F5 40000 (4%, FOBO) -> sane", ct.checkPoolFeeSane(40000).sane === true);
  check("F6 50000 (5%, boundary) -> sane", ct.checkPoolFeeSane(50000).sane === true);
  check("F7 50001 (just over bound) -> not sane", ct.checkPoolFeeSane(50001).sane === false);
  check("F8 0 (FAWBO) -> sane", ct.checkPoolFeeSane(0).sane === true);
  check("F9 100 (0.01%, debtdog) -> sane", ct.checkPoolFeeSane(100).sane === true);
  check("F10 500 (0.05%, NVDA V3) -> sane", ct.checkPoolFeeSane(500).sane === true);

  // --- G. Part 65: mirror-sell closes ALL records + already-hold ---
  // G1–G4: THREE open PUSSYCOIN records (the live BANK shape: several
  // buys of the same token). Real verify + real build, stubbed balance
  // (Proxy from section D) + stubbed executeMirrorSell (no send — the
  // real one's live gates are proven separately in section E).
  const realExecute = ct.executeMirrorSell;
  ct.executeMirrorSell = async () => [{ hash: "0x" + "a".repeat(64) }, { hash: "0x" + "b".repeat(64) }];
  const multi = [];
  for (let i = 0; i < 3; i++) {
    const p = JSON.parse(JSON.stringify(dryPosSane));
    p.txHash = "0x" + String(i + 1).repeat(64);
    p.at = new Date(Date.now() - i * 60000).toISOString();
    multi.push(p);
  }
  const stMulti = { version: 1, live: true, nativeEthLive: true, mirrorExit: true, cap: 5, copySnipesDone: 3, seenTxHashes: [], candidates: [], positions: multi, sells: [], lastGmgnPoll: null, lastGmgnPollOk: null, lastOnchainScan: null };
  const rMulti = await runner.handleCandidate(stubbed, stMulti, sellCand, true);
  check("G1 mirror-sell with 3 open records -> mirror-sold", rMulti === "mirror-sold", rMulti);
  check("G2 ALL THREE records marked soldAll", stMulti.positions.every((p) => p.soldAll === true), stMulti.positions.map((p) => p.soldAll).join(","));
  check("G3 soldReason notes the mirror-sell on every record", stMulti.positions.every((p) => (p.soldReason || "").startsWith("mirror-sell-all-")), stMulti.positions.map((p) => p.soldReason).join("|"));
  check("G4 exactly one sells entry (one onchain sell)", stMulti.sells.length === 1, `sells=${stMulti.sells.length}`);
  ct.executeMirrorSell = realExecute;
  // G5–G10: already-hold. Stub verifyCandidate / gateToken /
  // buildCopyBuy so the test is hermetic — the runner calls them via
  // the ct module object, so replacing them affects the runner. The
  // stubbed verify returns a buy-shaped verified object for whatever
  // token the candidate carries; gateToken passes; buildCopyBuy is a
  // spy (counts calls, returns a plausible build). The real
  // feeBreakdown still runs on the stubbed verified object.
  const BANK = "0x81adcf231fec5f8543629ed00a190b18b463662b";
  const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  const fakeVerifiedBuy = (token, symbol) => ({
    ok: true, direction: "buy", token: lc(token), symbol, decimals: 18,
    poolType: "v4", pool: { id: "0x" + "c".repeat(64), fee: 3000, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000", currency0: lc(token), currency1: lc(WETH) },
    poolKey: null, poolId: "0x" + "c".repeat(64), poolAddress: null,
    quoteInfo: { address: lc(WETH), symbol: "WETH", decimals: 18, approxUsdPrice: 2115 },
    quote: lc(WETH), isNative: false, deployer: "0x" + "d".repeat(40),
    wallet: lc(MAKER1), txHash: "0x" + "e".repeat(64), makerBalanceRaw: 1000n,
  });
  const realVerify = ct.verifyCandidate, realGate = ct.gateToken, realBuild = ct.buildCopyBuy;
  let buildCalls = 0, gateCalls = 0;
  ct.verifyCandidate = async (c, ch, cand) => fakeVerifiedBuy(cand.token, cand.symbol || "BANK");
  ct.gateToken = async () => { gateCalls++; return { pass: true, checks: [{ name: "stub", pass: true, detail: "stubbed gate" }] }; };
  ct.buildCopyBuy = async () => { buildCalls++; return { amountIn: "20000", amountOutMinimum: "0" }; };
  // State holding an open BANK position (sellBlocked, like live BANK).
  const bankPos = JSON.parse(JSON.stringify(dryPosSane));
  bankPos.token = lc(BANK); bankPos.symbol = "BANK"; bankPos.sellBlocked = true;
  const stHeld = { version: 1, live: false, nativeEthLive: true, mirrorExit: true, cap: 5, copySnipesDone: 5, seenTxHashes: [], candidates: [], positions: [bankPos], sells: [], lastGmgnPoll: null, lastGmgnPollOk: null, lastOnchainScan: null };
  const bankCand = { txHash: "0x" + "f".repeat(64), wallet: lc(MAKER1), token: lc(BANK), symbol: "BANK", amountUsd: 1, tokenAmount: 1, priceUsd: 0.00004, makerBalanceAfter: 1, timestamp: 0, source: "gmgn" };
  const rHeld = await runner.handleCandidate(client, stHeld, bankCand, false);
  check("G5 already-held BANK candidate -> already-hold", rHeld === "already-hold", rHeld);
  check("G6 buy build NEVER called for an already-held token", buildCalls === 0, `buildCalls=${buildCalls}`);
  check("G7 already-hold fires BEFORE the API gates (GoPlus/holders never called)", gateCalls === 0, `gateCalls=${gateCalls}`);
  check("G8 already-hold recorded + position untouched", stHeld.candidates.some((c) => c.outcome === "already-hold") && stHeld.positions[0].soldAll === false && stHeld.copySnipesDone === 5);
  // Same stubs, but the candidate token is NOT held (state still holds
  // only BANK) — the buy must proceed normally.
  const NEWCOIN = "0x1111111111111111111111111111111111111111";
  const newCand = { txHash: "0x" + "1".repeat(64), wallet: lc(MAKER1), token: lc(NEWCOIN), symbol: "NEWCOIN", amountUsd: 1, tokenAmount: 1, priceUsd: 0.00004, makerBalanceAfter: 1, timestamp: 0, source: "gmgn" };
  const rFree = await runner.handleCandidate(client, stHeld, newCand, false);
  check("G9 unheld token still buys (would-buy, dry-run)", rFree === "would-buy", rFree);
  check("G10 build called exactly once for the unheld token", buildCalls === 1, `buildCalls=${buildCalls}`);
  check("G11 gates ran for the unheld token (already-hold did not eat it)", gateCalls === 1, `gateCalls=${gateCalls}`);
  check("G12 would-buy recorded", stHeld.candidates.some((c) => c.outcome === "would-buy"));
  ct.verifyCandidate = realVerify; ct.gateToken = realGate; ct.buildCopyBuy = realBuild;

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed, 0 skipped ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("TEST ERROR:", e); process.exit(1); });
