// gates-test.js — tests for the Part 51 fresh-sniping gates:
//   1. token-age gate (token-age.js) — first pool < 24h old, hard veto
//   2. min-500-tokens rule — $0.02 buy must yield >= 500 whole tokens
//   3. priceFromSqrt precision fix (chains.js) — no more 0 for tiny sqrt
//   4. holders timeout fix is covered by holders-test.js (38/38)
//
// Usage: node gates-test.js
// Live sections hit Dexscreener + GeckoTerminal + RPCs (read-only).
// Evaluator sections run evaluatePool/evaluateV3Pool in-process (dry-run:
// no txs are sent) but DO record evaluations to memory.sqlite, like the
// other replay scripts. No STATE.json writes, no live flags touched.
const chains = require("./chains.js");
const ta = require("./token-age.js");
const holders = require("./holders.js");

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name + " " + (extra || "")); }
}

const FOBO = "0x000de658153f47f23e92973c8eb1e89762703676";
const MUSE = "0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198";

(async () => {
  const cfg = require("./config.json");
  const rh = { chainId: 4663, ...cfg.chains["4663"] };
  const arc = { chainId: 5042, ...cfg.chains["5042"] };

  // ---------- A. priceFromSqrt (pure) ----------
  console.log("--- A. priceFromSqrt ---");
  const foboPrice = chains.priceFromSqrt(7019216284471902465404n, 18, 6);
  check("FOBO USDG/FOBO ~0.00785 (was 0)", Math.abs(foboPrice - 0.007849) < 0.0001, `(got ${foboPrice})`);
  check("parity sqrt (1.0) -> 1", chains.priceFromSqrt(2n ** 96n, 18, 18) === 1);
  const tiny = BigInt(Math.floor(1e-9 * 2 ** 96));
  const tinyPrice = chains.priceFromSqrt(tiny, 18, 6);
  check("tiny sqrt (ratio 1e-9) -> nonzero ~1e-6 (old code gave 0)", tinyPrice > 0 && Math.abs(tinyPrice - 1e-6) < 1e-9, `(got ${tinyPrice})`);
  // Normal-range equivalence: new float formula vs the old 6dp-scaled
  // formula must agree where the old one worked (ratio >> 1e-6).
  const normalSqrt = (2n ** 96n * 3n) / 2n; // ratio 1.5
  const oldRatio = Number((normalSqrt * 1000000n) / (2n ** 96n)) / 1e6;
  const oldPrice = oldRatio * oldRatio * 10 ** (18 - 18);
  const newPrice = chains.priceFromSqrt(normalSqrt, 18, 18);
  check("normal range: new == old (within 1e-9 rel)", Math.abs(newPrice - oldPrice) / oldPrice < 1e-9, `(old ${oldPrice}, new ${newPrice})`);
  // Big-tick sanity: ratio 1e6 -> price 1e12 (no overflow).
  const bigSqrt = (2n ** 96n) * 1000000n;
  check("huge sqrt (ratio 1e6) -> 1e12", chains.priceFromSqrt(bigSqrt, 18, 18) === 1e12);

  // ---------- B. evaluateAge (pure) ----------
  console.log("--- B. evaluateAge ---");
  const now = Date.now();
  check("23h59m old -> pass", ta.evaluateAge(now - 23.99 * 3600000, now).decision === "pass");
  check("24h01m old -> reject", ta.evaluateAge(now - 24.02 * 3600000, now).decision === "reject");
  check("null -> unknown", ta.evaluateAge(null, now).decision === "unknown");
  check("future timestamp -> pass (clock skew)", ta.evaluateAge(now + 3600000, now).decision === "pass");
  check("exactly 24h -> reject", ta.evaluateAge(now - 24 * 3600000, now).decision === "reject");

  // ---------- C. token-age live ----------
  console.log("--- C. token-age live ---");
  // FOBO: both sources must agree on 2026-10-26T17:02:37Z.
  const dexFobo = await ta.dexscreenerFirstPool(FOBO, 4000);
  const gtFobo = await ta.geckoterminalFirstPool("robinhood", FOBO, 4000, now - 24 * 3600000);
  check("FOBO Dexscreener first pool 2026-10-26T17:02:37Z",
    dexFobo.firstPoolAtMs === Date.parse("2026-10-26T17:02:37Z"), `(got ${dexFobo.firstPoolAtMs ? new Date(dexFobo.firstPoolAtMs).toISOString() : dexFobo.firstPoolAtMs})`);
  check("FOBO GeckoTerminal first pool 2026-10-26T17:02:37Z",
    gtFobo.firstPoolAtMs === Date.parse("2026-10-26T17:02:37Z"), `(got ${gtFobo.firstPoolAtMs ? new Date(gtFobo.firstPoolAtMs).toISOString() : gtFobo.firstPoolAtMs})`);
  const foboAge = await ta.checkTokenAge(rh, FOBO);
  check("FOBO gate REJECTS (known, ~13 days old)", foboAge.known && ta.evaluateAge(foboAge.firstPoolAtMs, now).decision === "reject",
    `(known=${foboAge.known} ageH=${foboAge.ageHours !== null ? foboAge.ageHours.toFixed(1) : null} sources=${foboAge.sources.join("+")})`);
  // CLAUDIA: first pool ~1.2h old at build time — must PASS.
  const claudiaAge = await ta.checkTokenAge(rh, "0x575eac8bfa0d978be1c853e6ad0f269dd080e10e");
  check("CLAUDIA gate PASSES (known, < 24h)", claudiaAge.known && ta.evaluateAge(claudiaAge.firstPoolAtMs, now).decision === "pass",
    `(known=${claudiaAge.known} ageH=${claudiaAge.ageHours !== null ? claudiaAge.ageHours.toFixed(1) : null})`);
  // SI: 34 days old — must REJECT.
  const siAge = await ta.checkTokenAge(rh, "0xe4300104dfb44a2cadd2659e0618c8c6d6cd2dc6");
  check("SI gate REJECTS (known, ~34 days old)", siAge.known && ta.evaluateAge(siAge.firstPoolAtMs, now).decision === "reject",
    `(ageH=${siAge.ageHours !== null ? siAge.ageHours.toFixed(1) : null})`);
  // $MUSE on Arc: Dexscreener has NOTHING (returns no pairs); GeckoTerminal
  // is the only source — first pool 2026-11-06T17:10:27Z, ~40h old -> REJECT.
  const dexMuse = await ta.dexscreenerFirstPool(MUSE, 4000);
  check("$MUSE Dexscreener returns no pairs (Arc not indexed)", dexMuse.pairs === 0, `(pairs=${dexMuse.pairs})`);
  const museAge = await ta.checkTokenAge(arc, MUSE);
  check("$MUSE gate REJECTS via GeckoTerminal (known, ~40h old)", museAge.known && ta.evaluateAge(museAge.firstPoolAtMs, now).decision === "reject",
    `(known=${museAge.known} sources=${museAge.sources.join("+")} ageH=${museAge.ageHours !== null ? museAge.ageHours.toFixed(1) : null})`);
  check("$MUSE GeckoTerminal first pool 2026-11-06T17:10:27Z",
    museAge.firstPoolAtMs === Date.parse("2026-11-06T17:10:27Z"), `(got ${museAge.firstPoolAtMs ? new Date(museAge.firstPoolAtMs).toISOString() : museAge.firstPoolAtMs})`);
  // DELTA: first pool 2026-07-31 — must REJECT.
  const deltaAge = await ta.checkTokenAge(rh, "0xe8ffd7e24187f72afb08d75b1bb13088a989a791");
  check("DELTA gate REJECTS (known, ~99 days old)", deltaAge.known && ta.evaluateAge(deltaAge.firstPoolAtMs, now).decision === "reject",
    `(ageH=${deltaAge.ageHours !== null ? deltaAge.ageHours.toFixed(1) : null} sources=${deltaAge.sources.join("+")})`);

  // ---------- D. min-500 + gates live via evaluators (dry-run) ----------
  console.log("--- D. evaluator gates live ---");
  const { evaluatePool } = require("./evaluate.js");
  const client = chains.makeClient(rh);
  const latestRh = Number(await client.getBlockNumber());
  async function v2Pool(poolId, fromBlock, toBlock) {
    const logs = await holders.fetchLogsPaced(client, {
      address: rh.poolManager,
      topics: [chains.INITIALIZE_TOPIC0, poolId],
      fromBlock, toBlock,
    });
    if (logs.length === 0) throw new Error("pool Initialize log not found: " + poolId);
    return chains.decodeInitialize(logs[0]);
  }
  // FOBO/ETH deep pool (Initialize block 98573047, verified 2026-11-08).
  // NOTE on scope: the evaluator's check 1 (quote-pair) only accepts ERC20
  // quotes from the chain allowlist. The FOBO/ETH pool's quote is NATIVE
  // ETH (currency0 0x0), so the evaluator SKIPs it as "not a quote pair"
  // before any gate runs — pre-existing behaviour, not a gate bug: the
  // sniper only buys against ERC20 quotes (USDG/WETH). The FOBO/USDG pool
  // (the one actually bought) now has 0 liquidity, so it fails the
  // honeypot check (check 7) before reaching the gates. Neither FOBO pool
  // can therefore reach the min-500 gate inside the evaluator — the
  // min-500 reject is proven below at the gate's own computation level,
  // on the live, deep, liquid FOBO/ETH pool state, using the exact
  // functions the gate calls (buyAmountInQuote + spotOutput).
  const foboEthPool = await v2Pool("0x32c50d83271c3af69696fe6b08def9c4f26d38b640da2cdb2a7c39acd8bbca5a", 98563047, 98583047);
  const foboEthEval = await evaluatePool(cfg, rh, foboEthPool);
  check("FOBO/ETH SKIP 'not a quote pair' (native-ETH pools never reach the gates — pre-existing scope)",
    foboEthEval.verdict === "SKIP" && foboEthEval.reason === "not a quote pair",
    `(verdict=${foboEthEval.verdict} reason=${foboEthEval.reason})`);
  // Min-500 arithmetic on live FOBO/ETH state: $0.02 in WETH at the pool's
  // spot price must yield ~2.4 whole FOBO (< 500) — the exact numbers the
  // gate computes (quoter path would agree: the pool is deep and liquid).
  const trade = require("./trade.js");
  const wethQuote = (rh.quotes || []).find((q) => q.symbol === "WETH");
  const foboEthState = await chains.readPoolState(client, rh.poolManager, foboEthPool.poolId);
  const amountInWeth = await trade.buyAmountInQuote(cfg, rh, wethQuote, client);
  const foboOut = trade.spotOutput(amountInWeth, foboEthState.sqrtPriceX96, 18, 18, true /* zeroForOne: ETH -> FOBO */);
  const foboWhole = Number(foboOut) / 1e18;
  check("FOBO min-500 arithmetic REJECTS: $0.02 -> ~2.4 FOBO < 500",
    foboWhole > 1 && foboWhole < 500, `(expectedWhole=${foboWhole.toFixed(2)} — matches the live buy's 2.43 tokens)`);
  // FOBO/USDG (the pool actually bought, now 0 liq): check 6 (active
  // liquidity) fires before the gates — documents the gate order, not a
  // gate failure. A pool with no liquidity never reaches token-age/min-500.
  const foboUsdgPool = await v2Pool("0x296aefc6d09d703ae59a511bd90a3917e272dd6df26783d3251b7b825fb55b4a", latestRh - 500000, latestRh);
  const foboUsdgEval = await evaluatePool(cfg, rh, foboUsdgPool);
  check("FOBO/USDG SKIP via 'no active liquidity' (check 6) before the gates — gate order documented",
    foboUsdgEval.verdict === "SKIP" && foboUsdgEval.reason === "no active liquidity",
    `(verdict=${foboUsdgEval.verdict} reason=${foboUsdgEval.reason})`);
  // CLAUDIA (fresh, ~1.2h): both gates must PASS in the real evaluator.
  // Its score was 30/100 before, so the verdict is PASS + size watch —
  // the gates pass; the score keeps it out, as designed.
  const claudiaPool = await v2Pool("0xb10ecd6616b1777f2287544700eb79c2999952daa597a4cc2df376b25078fcd2", latestRh - 500000, latestRh);
  const claudia = await evaluatePool(cfg, rh, claudiaPool);
  const clAgeCheck = (claudia.checks || []).find((c) => c.check === "token-age");
  const clMinCheck = (claudia.checks || []).find((c) => c.check === "min-500-tokens");
  check("CLAUDIA token-age check PASSES in evaluator", clAgeCheck && clAgeCheck.pass, `(${clAgeCheck ? clAgeCheck.detail : "missing"})`);
  check("CLAUDIA min-500 check PASSES in evaluator", clMinCheck && clMinCheck.pass, `(${clMinCheck ? clMinCheck.detail : "missing"} expectedWhole=${claudia.expectedBuyTokensWhole})`);
  check("CLAUDIA verdict PASS + watch (gates pass, score keeps it out)", claudia.verdict === "PASS" && claudia.size === "watch",
    `(verdict=${claudia.verdict} size=${claudia.size} score=${claudia.score})`);
  // DELTA V3: age gate must SKIP it (99 days old).
  const { evaluateV3Pool, readV3PoolState } = require("./v3.js");
  const deltaState = await readV3PoolState(client, "0xD64FbdA67E1015dF43Fa5e49F02cA844729E5F94");
  const deltaPool = {
    token0: deltaState.token0, token1: deltaState.token1,
    fee: deltaState.fee, tickSpacing: deltaState.tickSpacing,
    pool: "0xD64FbdA67E1015dF43Fa5e49F02cA844729E5F94",
    blockNumber: 24555353, txHash: "0x301f5b492bdf3f985f7f0d37d1616b07df53f8325f03407be7805412be598e87", logIndex: 0,
  };
  const deltaV3 = await evaluateV3Pool(cfg, rh, deltaPool);
  const dAgeCheck = (deltaV3.checks || []).find((c) => c.check === "token-age");
  check("DELTA V3 SKIP via token-age", deltaV3.verdict === "SKIP" && deltaV3.reason.includes("too old") && dAgeCheck && !dAgeCheck.pass,
    `(verdict=${deltaV3.verdict} reason=${deltaV3.reason})`);
  // DELTA V3 with the age gate OFF: the min-500 gate ALONE rejects it —
  // DELTA is expensive (~$0.005/DELTA), so $0.02 buys only ~3.9 whole
  // tokens. Second evaluator-level min-500 reject proof (after FOBO's
  // arithmetic proof above): DELTA is blocked by BOTH gates independently.
  process.env.TOKEN_AGE_ENABLED = "0";
  process.env.MIN500_ENABLED = "1";
  const deltaV3NoAge = await evaluateV3Pool(cfg, rh, deltaPool);
  const dMinCheck = (deltaV3NoAge.checks || []).find((c) => c.check === "min-500-tokens");
  check("DELTA V3 SKIP via min-500 alone (age gate off): ~3.9 tokens < 500",
    deltaV3NoAge.verdict === "SKIP" && dMinCheck && !dMinCheck.pass && Number.isFinite(deltaV3NoAge.expectedBuyTokensWhole) && deltaV3NoAge.expectedBuyTokensWhole < 500,
    `(verdict=${deltaV3NoAge.verdict} expectedWhole=${deltaV3NoAge.expectedBuyTokensWhole})`);
  delete process.env.TOKEN_AGE_ENABLED;
  delete process.env.MIN500_ENABLED;

  console.log(`\n=== gates-test: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error("GATES-TEST ERROR:", e); process.exit(1); });
