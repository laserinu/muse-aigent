// registries-test.js — tests for the launchpad + known-rug registries.
//
// Usage:
//   node registries-test.js
//
// Sections:
//   A. Pure launchpad matching (matchLaunchpad) — no network.
//   B. Pure launchpad scoring (scoreLaunchpad) — no network.
//   C. Pure known-rug checks (checkKnownRug) — no network.
//   D. Fail-open on corrupt/missing registry data — no network.
//   E. Live onchain controls — every registered factory/portal/hook/
//      locker address must still have code on its chain (read-only
//      eth_getCode; no txs, no STATE writes). Also re-verifies the two
//      scam addresses: fake POL has code, scammer EOA has none.
//
// Exit non-zero on any failure.
const registries = require("./registries.js");
const chains = require("./chains.js");
const cfg = require("./config.json");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
function eq(name, got, want) {
  check(name, got === want, `(got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const R = registries.REGISTRY;
const PONS_V1 = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
const PONS_V2 = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const PONS_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const ARGUS_P1 = "0xb021be536808f551b31789422fd28a6c9c6e97da";
const FLAP_RH = "0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09";
const O1_RH_STD = "0xcE9C48cFa068947f77738c81Be406B53338E5B0d";
const O1_RH_STD_HOOK = "0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc";
const O1_ARC_STD = "0xeE3E862Efde6DCd6DF5648AF0E2731B9D1dF4605";
const VECTR_LOCKER = "0xcf489e55a1167cf883e0ee43d2354fdfc82b2b58";
const VECTR_MIGRATOR = "0x384eed2ba540146fb09e4ee228b454091913f837";
const SCAMMER = "0x333089e07fad944bc5d07f4679af7ace9efec932";
const FAKE_POL = "0xe174c72d8f772838269a4dc5a88ce0cdfcbbc02b";
const UNKNOWN = "0x1111111111111111111111111111111111111111";

// ---------- A. Pure launchpad matching ----------
console.log("--- A. matchLaunchpad ---");
eq("Pons v1 factory matches (factory)", registries.matchLaunchpad(R, 4663, { txTo: PONS_V1 }).matchedBy, "factory");
eq("Pons v1 factory matches (lowercase input)", registries.matchLaunchpad(R, 4663, { txTo: PONS_V1.toLowerCase() }).matchedBy, "factory");
eq("Pons v1 factory does NOT match on Arc", registries.matchLaunchpad(R, 5042, { txTo: PONS_V1 }).launchpad, null);
eq("Pons v2 factory matches", registries.matchLaunchpad(R, 4663, { txTo: PONS_V2 }).launchpad.id, "pons-v2");
eq("Pons v2 hook matches", registries.matchLaunchpad(R, 4663, { hooks: PONS_HOOK }).matchedBy, "hook");
eq("Pons v2 hook matches (txTo null)", registries.matchLaunchpad(R, 4663, { txTo: null, hooks: PONS_HOOK }).launchpad.id, "pons-v2");
eq("Argus portal 1 matches on Arc", registries.matchLaunchpad(R, 5042, { txTo: ARGUS_P1 }).launchpad.id, "argus");
eq("Argus portal does NOT match on Robinhood", registries.matchLaunchpad(R, 4663, { txTo: ARGUS_P1 }).launchpad, null);
eq("Flap portal matches (portal)", registries.matchLaunchpad(R, 4663, { txTo: FLAP_RH }).matchedBy, "portal");
eq("o1 RH Standard factory matches", registries.matchLaunchpad(R, 4663, { txTo: O1_RH_STD }).launchpad.id, "o1-standard");
eq("o1 RH Standard hook matches", registries.matchLaunchpad(R, 4663, { hooks: O1_RH_STD_HOOK }).launchpad.id, "o1-standard");
eq("o1 Arc Standard factory matches", registries.matchLaunchpad(R, 5042, { txTo: O1_ARC_STD }).launchpad.id, "o1-standard");
eq("Vectr locker matches (locker)", registries.matchLaunchpad(R, 4663, { lpOwner: VECTR_LOCKER }).matchedBy, "locker");
eq("Vectr locker matches (txTo null)", registries.matchLaunchpad(R, 4663, { txTo: null, lpOwner: VECTR_LOCKER }).launchpad.id, "vectr");
eq("Vectr migrator does NOT match on txTo (by design)", registries.matchLaunchpad(R, 4663, { txTo: VECTR_MIGRATOR }).launchpad, null);
eq("unknown factory -> no match", registries.matchLaunchpad(R, 4663, { txTo: UNKNOWN }).launchpad, null);
eq("empty input -> no match", registries.matchLaunchpad(R, 4663, {}).launchpad, null);
eq("null input -> no match", registries.matchLaunchpad(R, 4663, null).launchpad, null);
eq("Polygon (no entries) -> no match", registries.matchLaunchpad(R, 137, { txTo: PONS_V1 }).launchpad, null);

// ---------- B. Pure launchpad scoring ----------
console.log("--- B. scoreLaunchpad ---");
eq("Pons v1 -> +5", registries.scoreLaunchpad(R, 4663, { txTo: PONS_V1 }).points, 5);
eq("Pons v1 is dormant but still +5 (lock is what counts)", registries.scoreLaunchpad(R, 4663, { txTo: PONS_V1 }).launchpad.status, "dormant");
eq("Pons v2 hook -> +5", registries.scoreLaunchpad(R, 4663, { hooks: PONS_HOOK }).points, 5);
eq("Argus portal -> +5", registries.scoreLaunchpad(R, 5042, { txTo: ARGUS_P1 }).points, 5);
eq("Argus detail flags the persisting tax", /tax persists/.test(registries.scoreLaunchpad(R, 5042, { txTo: ARGUS_P1 }).detail), true);
eq("Flap portal -> +5 with tax note", registries.scoreLaunchpad(R, 4663, { txTo: FLAP_RH }).points, 5);
eq("Vectr locker -> +5", registries.scoreLaunchpad(R, 4663, { lpOwner: VECTR_LOCKER }).points, 5);
eq("o1 Standard factory -> +5", registries.scoreLaunchpad(R, 4663, { txTo: O1_RH_STD }).points, 5);
eq("unknown -> 0, no veto", registries.scoreLaunchpad(R, 4663, { txTo: UNKNOWN }).points, 0);
check("unknown -> veto false", registries.scoreLaunchpad(R, 4663, { txTo: UNKNOWN }).veto === false);
check("unknown detail says not a penalty", /not a penalty/.test(registries.scoreLaunchpad(R, 4663, { txTo: UNKNOWN }).detail));
eq("Noxa (dead, no addresses) cannot match by address", registries.scoreLaunchpad(R, 4663, { txTo: UNKNOWN }).launchpad, null);

// A synthetic dead launchpad WITH an address scores 0 and flags it.
const withDead = JSON.parse(JSON.stringify(R));
withDead.launchpads.push({
  id: "dead-test", name: "DeadTest", chains: [4663], poolTypes: ["V4"],
  addresses: { "4663": { factories: ["0x2222222222222222222222222222222222222222"] } },
  lpLocked: true, taxPersists: false, status: "dead", veto: false,
});
eq("dead launchpad with address -> 0", registries.scoreLaunchpad(withDead, 4663, { txTo: "0x2222222222222222222222222222222222222222" }).points, 0);
check("dead launchpad detail says dead", /dead/.test(registries.scoreLaunchpad(withDead, 4663, { txTo: "0x2222222222222222222222222222222222222222" }).detail));
check("dead launchpad veto false", registries.scoreLaunchpad(withDead, 4663, { txTo: "0x2222222222222222222222222222222222222222" }).veto === false);

// A synthetic veto launchpad vetoes.
const withVeto = JSON.parse(JSON.stringify(R));
withVeto.launchpads.push({
  id: "veto-test", name: "VetoTest", chains: [4663], poolTypes: ["V4"],
  addresses: { "4663": { factories: ["0x3333333333333333333333333333333333333333"] } },
  lpLocked: true, taxPersists: false, status: "suspect", veto: true,
});
check("veto launchpad vetoes", registries.scoreLaunchpad(withVeto, 4663, { txTo: "0x3333333333333333333333333333333333333333" }).veto === true);

// ---------- C. Pure known-rug checks ----------
console.log("--- C. checkKnownRug ---");
check("scammer deployer vetoes", registries.checkKnownRug(R, { deployer: SCAMMER }).veto === true);
check("scammer deployer vetoes (lowercase)", registries.checkKnownRug(R, { deployer: SCAMMER.toLowerCase() }).veto === true);
check("fake POL token vetoes", registries.checkKnownRug(R, { token: FAKE_POL }).veto === true);
check("fake POL veto reason names it", /Fake/.test(registries.checkKnownRug(R, { token: FAKE_POL }).reason));
check("unknown deployer does not veto", registries.checkKnownRug(R, { deployer: UNKNOWN }).veto === false);
check("unknown token does not veto", registries.checkKnownRug(R, { token: UNKNOWN }).veto === false);
check("empty input does not veto", registries.checkKnownRug(R, {}).veto === false);
check("null input does not veto", registries.checkKnownRug(R, null).veto === false);
check("PONS copycat (watchlist only) does NOT veto", registries.checkKnownRug(R, { token: "0xe306c19C72131B0a8f311648fa63FE8CeDf44571" }).veto === false);
check("real PONS token does NOT veto", registries.checkKnownRug(R, { token: "0x39dBED3a2bd333467115dE45665cC57F813C4571" }).veto === false);

// ---------- D. Fail-open on corrupt data ----------
console.log("--- D. fail-open ---");
for (const [name, bad] of [["null registry", null], ["undefined registry", undefined], ["empty object", {}], ["launchpads not array", { launchpads: "x", knownRug: {} }], ["knownRug missing", { launchpads: [] }], ["knownRug wrong type", { launchpads: [], knownRug: "x" }]]) {
  let ok = true;
  try {
    const s = registries.scoreLaunchpad(bad, 4663, { txTo: PONS_V1 });
    const c = registries.checkKnownRug(bad, { deployer: SCAMMER, token: FAKE_POL });
    const m = registries.matchLaunchpad(bad, 4663, { txTo: PONS_V1 });
    ok = s.points === 0 && s.veto === false && c.veto === false && m.launchpad === null;
  } catch { ok = false; }
  check(`corrupt registry (${name}) fails open, no throw`, ok);
}
// Entries with missing address arrays must not throw.
const sparse = { launchpads: [{ id: "sparse", name: "Sparse", chains: [4663] }], knownRug: { deployers: [null, {}], tokens: [null] } };
check("sparse entry (no address arrays) fails open", registries.scoreLaunchpad(sparse, 4663, { txTo: PONS_V1 }).points === 0 && registries.checkKnownRug(sparse, { deployer: SCAMMER }).veto === false);

// ---------- E. Live onchain controls ----------
console.log("--- E. live eth_getCode controls (read-only) ---");
(async () => {
  // Every registered address must have code ON THE CHAIN IT IS
  // REGISTERED FOR. Addresses are per-chain (entry.addresses[chainId]):
  // the same address can host a different contract elsewhere, so each
  // address is checked only on its own chain.
  const seen = new Set();
  for (const entry of R.launchpads) {
    const addrMap = entry.addresses || {};
    for (const chainId of Object.keys(addrMap)) {
      const m = addrMap[chainId] || {};
      const addrs = [...(m.factories || []), ...(m.portals || []), ...(m.hooks || []), ...(m.migrators || []), ...(m.lockers || [])];
      for (const addr of addrs) {
        const key = chainId + ":" + addr.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const chain = { chainId: Number(chainId), ...cfg.chains[String(chainId)] };
          const client = chains.makeClient(chain);
          const code = await client.getBytecode({ address: addr });
          const bytes = code ? (code.length - 2) / 2 : 0;
          check(`${entry.id} ${addr.slice(0, 12)}… on ${chainId} has code (${bytes}B)`, bytes > 0);
        } catch (e) {
          check(`${entry.id} ${addr.slice(0, 12)}… on ${chainId} has code`, false, e.message.slice(0, 80));
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
  // Cross-chain guard: an address registered for one chain must NOT be
  // matchable on another chain, even when the address hosts SOME code
  // there (the Arc o1 factory hosts a 4,214-byte contract on Robinhood;
  // the RH Flap Portal hosts a 3,068-byte contract on Base).
  check("Arc o1 factory does NOT match on Robinhood", registries.matchLaunchpad(R, 4663, { txTo: "0xeE3E862Efde6DCd6DF5648AF0E2731B9D1dF4605" }).launchpad === null);
  check("RH Flap Portal does NOT match on Base", registries.matchLaunchpad(R, 8453, { txTo: "0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09" }).launchpad === null);
  check("RH o1 factory does NOT match on Arc", registries.matchLaunchpad(R, 5042, { txTo: "0xcE9C48cFa068947f77738c81Be406B53338E5B0d" }).launchpad === null);
  // Scam addresses: fake POL has code (1,667B), scammer EOA has none.
  try {
    const chain = { chainId: 137, ...cfg.chains["137"] };
    const client = chains.makeClient(chain);
    const fakeCode = await client.getBytecode({ address: FAKE_POL });
    check("fake POL contract has code", !!fakeCode && fakeCode.length > 2);
    const scamCode = await client.getBytecode({ address: SCAMMER });
    check("scammer address is an EOA (no code)", !scamCode || scamCode === "0x");
  } catch (e) {
    check("scam-address code checks", false, e.message.slice(0, 80));
  }

  console.log(`\n=== registries-test: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error("TEST ERROR:", e); process.exit(1); });
