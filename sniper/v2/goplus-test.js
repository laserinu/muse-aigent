// goplus-test.js — tests for goplus.js (read-only, no transactions).
//
// Usage:
//   node goplus-test.js            # live probes + synthetic mapping tests
//   node goplus-test.js outage     # outage simulation only (bad base URL)
//
// Test 1 — live: scoreGoPlus against the real GoPlus API for known tokens.
// Test 2 — synthetic: scoreFromRaw against hand-built result objects, so
//   every mapping tier is covered without depending on live data.
// Test 3 — outage: GOPLUS_BASE_URL pointed at a dead port must return
//   0 points and never throw (fail-open).
const { scoreGoPlus, scoreFromRaw } = require("./goplus.js");

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log((ok ? "  PASS" : "  FAIL") + " " + name + " — got " + got + ", want " + want);
}

async function liveTests() {
  console.log("== Test 1: live scoreGoPlus ==");
  const cases = [
    { chain: 4663, token: "0x137aEA2D5fdb1e15711BbAfd31A038A933b5fd36", name: "$RMUSE (4663)" },
    { chain: 5042, token: "0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198", name: "$MUSE (5042)" },
    { chain: 4663, token: "0xe8ffd7e24187f72afb08d75b1bb13088a989a791", name: "DELTA (4663, Pons)" },
    { chain: 4663, token: "0xb30b3788187fed40f69bac0d33648439e9bd0087", name: "bottom (4663, v1 buy)" },
    { chain: 4663, token: "0x0000000000000000000000000000000000000001", name: "unindexed address" },
  ];
  for (const c of cases) {
    const r = await scoreGoPlus(c.chain, c.token, {});
    console.log(`  ${c.name}: points=${r.points} — ${r.detail}`);
  }
  // Assertions on the two we control (live data, so assert ranges, not exacts):
  const rmuse = await scoreGoPlus(4663, "0x137aEA2D5fdb1e15711BbAfd31A038A933b5fd36", {});
  check("$RMUSE is clean +5", rmuse.points, 5);
  const muse = await scoreGoPlus(5042, "0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198", {});
  // $MUSE has "" (unknown) taxes from the hook — no clean bonus, no penalty.
  check("$MUSE unknown taxes -> 0", muse.points, 0);
  const unindexed = await scoreGoPlus(4663, "0x0000000000000000000000000000000000000001", {});
  check("unindexed -> 0 fail-open", unindexed.points, 0);
}

function syntheticTests() {
  console.log("== Test 2: synthetic scoreFromRaw mapping ==");
  const base = {
    is_honeypot: "0", honeypot_with_same_creator: "0",
    buy_tax: "0", sell_tax: "0",
    hidden_owner: "0", is_proxy: "0", can_take_back_ownership: "0",
    creator_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    holders: [{ address: "0x1111111111111111111111111111111111111111", is_contract: 0, percent: "0.02" }],
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  check("clean -> +5", scoreFromRaw(clone(base), {}).points, 5);

  let r = clone(base); r.honeypot_with_same_creator = "1";
  check("creator-honeypot, creator==deployer -> -10",
    scoreFromRaw(r, { deployer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).points, -10);
  check("creator-honeypot, creator==factory -> -3",
    scoreFromRaw(r, { creatorContract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).points, -3);
  check("creator-honeypot, creator unknown relation -> -5",
    scoreFromRaw(r, {}).points, -5);

  r = clone(base); r.is_honeypot = "1";
  check("is_honeypot=1 -> -5 (sim wins, no veto)", scoreFromRaw(r, {}).points, -5);

  r = clone(base); r.buy_tax = "0.10";
  check("buy tax 10% -> -5", scoreFromRaw(r, {}).points, -5);
  r = clone(base); r.sell_tax = "0.02";
  check("sell tax 2% -> -2", scoreFromRaw(r, {}).points, -2);
  r = clone(base); r.buy_tax = ""; r.sell_tax = "";
  check("taxes unknown ('') -> no penalty, no bonus", scoreFromRaw(r, {}).points, 0);

  r = clone(base); r.hidden_owner = "1";
  check("hidden_owner=1 -> -5", scoreFromRaw(r, {}).points, -5);
  r = clone(base); r.is_proxy = "1";
  check("is_proxy=1 -> -5", scoreFromRaw(r, {}).points, -5);

  r = clone(base);
  r.holders = [
    { address: "0x2222222222222222222222222222222222222222", is_contract: 0, percent: "0.30" },
    { address: "0x3333333333333333333333333333333333333333", is_contract: 0, percent: "0.25" },
  ];
  check("top-10 non-contract 55% -> -5", scoreFromRaw(r, {}).points, -5);
  r.holders = [
    { address: "0x2222222222222222222222222222222222222222", is_contract: 0, percent: "0.25" },
    { address: "0x3333333333333333333333333333333333333333", is_contract: 0, percent: "0.20" },
  ];
  check("top-10 non-contract 45% -> -2", scoreFromRaw(r, {}).points, -2);
  r.holders = [
    { address: "0x4444444444444444444444444444444444444444", is_contract: 1, percent: "0.90" },
    { address: "0x2222222222222222222222222222222222222222", is_contract: 0, percent: "0.02" },
  ];
  check("90% contract holder excluded -> clean +5", scoreFromRaw(r, {}).points, 5);

  r = clone(base); r.is_honeypot = null; r.hidden_owner = null; r.is_proxy = null;
  check("null fields -> 0 (no bonus, no penalty)", scoreFromRaw(r, {}).points, 0);

  r = clone(base); r.is_honeypot = "1"; r.honeypot_with_same_creator = "1"; r.buy_tax = "0.10";
  check("stacked negatives clamp at -10", scoreFromRaw(r, { deployer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).points, -10);
}

async function outageTest() {
  console.log("== Test 3: outage simulation (GOPLUS_BASE_URL=http://127.0.0.1:9) ==");
  const { spawnSync } = require("child_process");
  const out = spawnSync(
    process.execPath,
    ["-e", "const {scoreGoPlus}=require('./goplus.js'); scoreGoPlus(4663,'0x137aEA2D5fdb1e15711BbAfd31A038A933b5fd36',{}).then(r=>console.log('points='+r.points+' detail='+r.detail)).catch(e=>{console.error('THREW: '+e.message); process.exit(2)})"],
    {
      cwd: __dirname,
      env: { ...process.env, GOPLUS_BASE_URL: "http://127.0.0.1:9", GOPLUS_TIMEOUT_MS: "1500" },
      encoding: "utf8", timeout: 20000,
    },
  );
  console.log("  stdout: " + (out.stdout || "").trim());
  if (out.stderr) console.log("  stderr: " + out.stderr.trim());
  check("outage returns 0, exit 0, no throw",
    out.status === 0 && (out.stdout || "").includes("points=0") ? 0 : 1, 0);
}

(async () => {
  const mode = process.argv[2];
  if (mode === "outage") {
    await outageTest();
  } else {
    await liveTests();
    syntheticTests();
    await outageTest();
  }
  console.log(failures === 0 ? "=== ALL GOPLUS TESTS PASSED ===" : `=== ${failures} GOPLUS TEST(S) FAILED ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("TEST HARNESS ERROR:", e.message); process.exit(1); });
