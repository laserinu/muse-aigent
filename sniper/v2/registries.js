// registries.js — curated launchpad + known-rug registries (Part 50).
//
// Built 2026-11-08 ~07:35-08:00 GMT+7 under the user's decide-freely
// instruction. This is the one config edit that turns two placeholder
// guards into live ones:
//   - `launchpad-provenance` (+5) was 0 for every pool because the registry
//     was empty (evaluate.js matched Initialize tx `to` / pool hooks against
//     config.launchpadContracts, which held only the four o1 factories).
//   - the deployer known-rug VETO was dead because config.knownRugDeployers
//     was empty.
// Both evaluators (evaluate.js V4, v3.js V3) now read this file.
//
// VERIFICATION STANDARD: every address in LAUNCHPADS / KNOWN_RUG was
// verified with eth_getCode on its chain in this session (2026-11-08
// ~00:40-00:45 UTC), except where the entry says otherwise. Sources are
// the official docs pages named per entry. NOTHING here is copied from
// memory — an address with no verified source goes in WATCHLIST, never in
// the scored registry.
//
// MATCHING RULES (matchLaunchpad):
//   - addresses are matched PER CHAIN ONLY (entry.addresses[chainId]):
//     the same address can host a different contract on another chain
//     (verified: Arc o1 factory 0xeE3E862E... is a 4,214-byte contract on
//     Robinhood, not the factory; RH Flap Portal is a 3,068-byte contract
//     on Base). Never match an address on a chain it was not verified for.
//   - receipt/Initialize tx `to` is matched against factories + portals
//     (+ Hood's launcher). Migrators are NOT matched on tx `to`: a Vectr
//     graduation tx is sent to the per-launch curve clone, which calls the
//     migrator internally — receipt.to is the curve, never the migrator.
//     Vectr attribution therefore runs on the LP-NFT owner (locker) only.
//   - pool.hooks is matched against hook addresses (V4: o1, Pons v2,
//     HedgeFun, Frontier, Duel).
//   - the LP-NFT owner (found by v3.js's lp-locked check) is matched
//     against locker addresses (Vectr locker, Pons v1 locker).
//   - only status "live" or "dormant" + lpLocked scores +5. "dormant"
//     (Pons v1: 0 factory logs in 500k blocks) still scores because the
//     lock property is what the +5 rewards, and a dormant factory cannot
//     produce new pools anyway. "not-live" / "suspect" / "dead" match but
//     score 0 and say so in the detail. A launchpad-level VETO fires only
//     when the entry sets veto: true (none do today — Noxa is dead with
//     veto: false: it halted with no fraud finding, so its death is a
//     venue flag, not proof a token is a rug).
//   - unknown launchpads score 0, never negative. Unknown is not a penalty.
//
// KNOWN-RUG RULES (checkKnownRug):
//   - deployers[] / tokens[] hold CONFIRMED scams only (veto: true).
//     Today: exactly two entries, both user-confirmed 2026-11-07 (MEMORY.md).
//     The deployer list otherwise starts EMPTY — the mechanism is live,
//     the curation is deliberately conservative. Never add an address on
//     suspicion alone; a deployer with bad outcomes belongs in memory.js
//     (reputation, ±25), not here.
//   - a veto fires when the pool's deployer (Initialize/PoolCreated tx
//     `from`) is a listed deployer OR the token itself is a listed token.
//
// FAIL-OPEN: every function validates its inputs; a corrupt / missing /
// wrong-typed registry degrades to "no match / no veto", never a throw.
// The evaluators also wrap the require in try/catch (same pattern as
// memory.js / goplus.js / holders.js), so a broken registries.js can
// never break evaluation — it just scores 0 like before this build.
//
// HOW TO CURATE (add an entry):
//   1. Verify the address onchain (eth_getCode on the right chain) AND
//      from the project's official docs/site.
//   2. Add the entry below with id, name, chains, poolTypes, addresses,
//      lpLocked, taxPersists, status, source, notes, verified.
//   3. Run: node registries-test.js && node registries-replay.js
//   4. Append the change to tools-and-sites.md (next Part) + report.
// To flag a venue dead/suspect: set status + veto as needed; no code
// change. To add a rug: append { address, reason, source } to the right
// KNOWN_RUG list (veto is automatic). Never edit the evaluators to add
// an address — the registry file is the single source of truth.

const REGISTRY_VERSION = 1;

const LAUNCHPADS = [
  // ---- Robinhood Chain (4663) ----
  {
    id: "pons-v1", name: "Pons v1", chains: [4663], poolTypes: ["V3"],
    addresses: {
      "4663": { factories: ["0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB"], lockers: ["0x736D76699C26D0d966744cAe304C000d471f7F35"] },
    },
    lpLocked: true, taxPersists: false, status: "dormant", veto: false,
    source: "tools-and-sites Part 36; research_notes/pons-launchpad-20261108-0243/report.md; github.com/bowdotfun/bowdotfun",
    notes: "CREATE2 factory mints 1B-supply token into a locked V3 WETH pool (1% fee, 0.0005 ETH launch fee). DORMANT: 0 factory logs in the last 500k blocks (~12 days, checked 2026-11-08) — action moved to Pons v2. Locker verified on DELTA: LP NFT #536074 now owned by the locker. Unaudited.",
    verified: "2026-11-08 eth_getCode 24,353 bytes (factory); locker 5,426 bytes via DELTA LP check (Part 43)",
  },
  {
    id: "pons-v2", name: "Pons v2", chains: [4663], poolTypes: ["V4"],
    addresses: {
      "4663": { factories: ["0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"], hooks: ["0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044"] },
    },
    lpLocked: true, taxPersists: false, status: "live", veto: false,
    source: "tools-and-sites Part 36; research_notes/pons-launchpad-20261108-0243/report.md; docs.ponsfamily.com",
    notes: "Bonding curve graduating into a permanently locked V4 pool; can pair with tokenized stocks. Hook is V2MemeHook. UNAUDITED — v2 reviews in progress (SB Security, Dingbats, Pashov Audit Group).",
    verified: "2026-11-08 eth_getCode factory 24,177 bytes, hook 15,167 bytes",
  },
  {
    id: "flap", name: "Flap", chains: [4663, 8453], poolTypes: ["V3"],
    addresses: {
      "4663": { portals: ["0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09"] },
      "8453": { portals: ["0x0000BC1c4fD15Dd79029AF8F5d77D68ae4490000"] },
    },
    lpLocked: true, taxPersists: true, status: "live", veto: false,
    source: "tools-and-sites Part 41; research_notes/alchemy-crypto-launchpads-20261108-0318/report.md; docs.flap.sh (deployed-contract-addresses)",
    notes: "#2 memecoin launchpad by fees ($21.98M/30d). 1B supply, curve graduates at 800M sold; ordinary tokens -> V3-type pool, tax tokens -> V2-type only. Tax (1/3/5/10%, asymmetric buy/sell in V3) PERSISTS after graduation — the honeypot sim is the guard, not this registry. Portal is an upgradeable proxy (3-of-4 multisig admin); implementation source NOT verified on Blockscout; Tax Token V3 has no standalone audit. ATTRIBUTION CAVEAT: receipt.to == Portal is assumed but NOT verified live (the curve may live in a per-launch clone, same pattern as Pools.xyz) — if a known Flap graduate replays at 0, the locker/owner signal is the fallback. NOTE: the Robinhood Portal address hosts a DIFFERENT 3,068-byte contract on Base and the Arc o1 factory address hosts a 4,214-byte contract on Robinhood — same address, different contract per chain. Addresses are therefore matched per-chain only; never match an address on a chain it was not verified for.",
    verified: "2026-11-08 eth_getCode Portal 2,840 bytes on BOTH chains (proxy; the Part 41 '5,682 bytes' was the hex-string length, corrected here)",
  },
  {
    id: "o1-standard", name: "o1 Exchange Standard", chains: [4663, 5042, 8453], poolTypes: ["V4"],
    addresses: {
      "4663": { factories: ["0xcE9C48cFa068947f77738c81Be406B53338E5B0d"], hooks: ["0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc"] },
      "5042": { factories: ["0xeE3E862Efde6DCd6DF5648AF0E2731B9D1dF4605"], hooks: ["0x20EEad6db6b3d0a4491E9073119DD0EBFF166AcC"] },
      "8453": { factories: ["0x1176122eb77AD6a2339322Cda7C4D7ea9BfA63dC"], hooks: ["0x1f91c998e7c2F4b690D75BDBf6502BDcD6e02AcC"] },
    },
    lpLocked: true, taxPersists: false, status: "live", veto: false,
    source: "o1exchange.mintlify.app/launchpad/reference/production-contracts (official); tools-and-sites Part 32 (DRY-RUN-TEST.md onchain check)",
    notes: "launchpad-v4-minimal family; permanent liquidity, optional atomic Dev Buy, 20-second anti-snipe window, 0.001 ETH launch fee (2 native USDC on Arc). 317 registered quotes on Base (18 crypto + 299 stocks); ETH/USD G + all 194 Robinhood stock tokens on 4663. The four factory addresses were ALREADY in config.launchpadContracts — this entry documents them.",
    verified: "2026-11-08 eth_getCode: RH factory 24,466 / hook 15,732 bytes; Arc factory 24,466 / hook 15,732; Base factory 24,488 / hook 15,732",
  },
  {
    id: "o1-tax", name: "o1 Exchange Tax", chains: [4663, 5042, 8453], poolTypes: ["V4"],
    addresses: {
      "4663": { factories: ["0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A"], hooks: ["0xe05521566199A3Ba8D8721C0e44E96018EB1EaCc"] },
      "5042": { factories: ["0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A"], hooks: ["0x7a3D518f9278f32E5D11D931C3B726831E6D6ACc"] },
      "8453": { factories: ["0x53C59d8d335681d58F564cF62073fA3C57cF81ee"], hooks: ["0x9C7155D7216454D9d894F792c8B5C564F2c66AcC"] },
    },
    lpLocked: true, taxPersists: true, status: "live", veto: false,
    source: "o1exchange.mintlify.app/launchpad/reference/production-contracts (official)",
    notes: "Tax suite (base-mainnet-tax-token-v2 family): inclusive trading tax + automatic holder-dividend accrual. Tax persists — honeypot sim is the guard. Same CREATE2 factory address on Robinhood/Arc/Monad (0x29CAD997...); Base differs.",
    verified: "2026-11-08 eth_getCode: factory 23,894 bytes on all three chains; hooks 21,519 bytes each",
  },
  {
    id: "o1-wsto", name: "o1 Exchange $O (wstO)", chains: [4663, 8453], poolTypes: ["V4"],
    addresses: {
      "4663": { factories: ["0xAC7Bd3254d7182a32ae3Ce7Fcd0ab86c88fcD91F"], hooks: ["0x96268D6832BF2c552Bb30c5fd6ea92228D816acc"] },
      "8453": { factories: ["0xAC7Bd3254d7182a32ae3Ce7Fcd0ab86c88fcD91F"], hooks: ["0xAa4B4fABf41754E759338778e6031A156EeA6aCc"] },
    },
    lpLocked: true, taxPersists: false, status: "live", veto: false,
    source: "o1exchange.mintlify.app/launchpad/reference/production-contracts (official)",
    notes: "Burn-only $O launches, paired with wstO. wstO is NOT in our quote allowlist, so these pools fail the quote-pair gate before scoring — the entry exists for correct attribution if a quote ever matches.",
    verified: "2026-11-08 eth_getCode: factory 21,430 bytes; hooks 13,584 bytes (both chains)",
  },
  {
    id: "o1-child", name: "o1 Launchpad of Launchpads (child Tax)", chains: [4663, 8453], poolTypes: ["V4"],
    addresses: {
      "4663": { factories: ["0xfF6ff1DFa6938707Db8dD78D7E74999e8177126f"], hooks: ["0xA72Db329ad404Afc85E07dfbF125Be9f977f2acc"] },
      "8453": { factories: ["0xfF6ff1DFa6938707Db8dD78D7E74999e8177126f"], hooks: ["0xFe97d6f3f59Ec48f2953c702e55e0ca199392aCC"] },
    },
    lpLocked: true, taxPersists: true, status: "live", veto: false,
    source: "o1exchange.mintlify.app/launchpad/reference/production-contracts (official)",
    notes: "Child Tax factory for tokens launched THROUGH a registered launchpad (PadRegistry). Same factory address on both chains (same deployer nonces); hooks differ per chain.",
    verified: "2026-11-08 eth_getCode: factory 23,894 bytes; hooks 22,247 bytes (both chains)",
  },
  {
    id: "vectr", name: "Vectr", chains: [4663], poolTypes: ["V3"],
    addresses: {
      "4663": { factories: ["0xb2f232389a4ee9285ceee5e7c1706a0484437873"], migrators: ["0x384eed2ba540146fb09e4ee228b454091913f837"], lockers: ["0xcf489e55a1167cf883e0ee43d2354fdfc82b2b58"] },
    },
    lpLocked: true, taxPersists: false, status: "live", veto: false,
    source: "vectr.bot/contracts (official, source-verified 6/6); tools-and-sites Part 41",
    notes: "Bonding curve graduating to V3 (1% tier) via VectrUniswapMigrator; LP NFT minted straight into VectrLPLocker (no withdraw/transfer path). No proxies, no upgrade keys. ATTRIBUTION: receipt.to is the per-launch curve clone, NEVER the migrator — match runs on the LP-NFT owner (locker) only. 0 graduations / 0 positions locked as of 2026-11-08 (5 factory launches) — the entry is forward-looking. Caveat: the factory owner CAN point future launches at new implementations and change a live token/curve's code.",
    verified: "2026-11-08 eth_getCode: factory 12,792 / migrator 14,654 / locker 6,915 bytes (page: 12.5KB / 14.3KB / 6.8KB)",
  },
  {
    id: "hood", name: "Hood (hood.dev)", chains: [4663], poolTypes: ["V3"],
    addresses: {
      "4663": { factories: ["0x5e4121c262B846eb518EF3EADCD5566838AA841F"] },
    },
    lpLocked: true, taxPersists: false, status: "live", veto: false,
    source: "hood.dev/docs/addresses (official, verified on Blockscout); search 2026-11-08",
    notes: "HoodLauncher: deploys token, opens V3 pool (1% tier), mints + locks the position in FeeLocker forever (collect() permissionless). Sniper-guard: 2% max-wallet cap for ~366 blocks (~1.2h) — our $0.02 buys are far below it. Launch fee 0.001 ETH, creator 70% of LP fees.",
    verified: "2026-11-08 eth_getCode 22,741 bytes; address confirmed as HoodLauncher by the page's own cast-call examples (launchFee/creatorBps)",
  },
  {
    id: "hedgefun", name: "HedgeFun (Hedgehood)", chains: [4663], poolTypes: ["V4"],
    addresses: {
      "4663": { factories: ["0x58F6Ced8d02cD2567f1458801440Bc4eb67fA961"], hooks: ["0x2A16d0973385952cFBE750D37f803d0958472844"] },
    },
    lpLocked: true, taxPersists: false, status: "live", veto: false,
    source: "docs.hedgehood.app/hedgefun/integration (official, verified read-only onchain 2026-09-22); search 2026-11-08",
    notes: "Stock-quoted V4 launches (each launch's pool is quoted in a stock, 12 stocks listed, publicLaunch=true since 2026-09-22). Six core contracts, frozen; Sourcify creation+runtime match. Factory owner + protocol + calendar owner are one Safe.",
    verified: "2026-11-08 eth_getCode: factory 18,929 / hook 18,481 bytes",
  },
  {
    id: "frontier", name: "Frontier", chains: [4663], poolTypes: ["V4"],
    addresses: {
      "4663": { factories: ["0xe3A826C056e578c240D362BF4C2fa53E5c0c17a5"], hooks: ["0xb31780AAd49D3Cc7Dd6E03E9e462606F0A5A30Cc"] },
    },
    lpLocked: true, taxPersists: false, status: "live", veto: false,
    source: "docs.frontier.fun/developers/contracts-and-addresses (official); search 2026-11-08",
    notes: "Bonding-curve launchpad; coins trade in standard V4 pools with a singleton FactoryHook. Pool params: dynamic-fee flag, tick spacing 60. Deployment in force since 2026-08-15; registry is authoritative over the docs table.",
    verified: "2026-11-08 eth_getCode: factory 11,321 / hook 19,382 bytes",
  },
  {
    id: "duel", name: "Duel (divine.sh)", chains: [4663], poolTypes: ["V4"],
    addresses: {
      "4663": { factories: ["0x3c6e7f9Bc507a442237AF1721B2294686495BD54"], hooks: ["0x5F746B7B1722e9bb3849EEa97061Df50F715AAEc"] },
    },
    lpLocked: true, taxPersists: false, status: "live", veto: false,
    source: "divine.sh/docs/duel/contracts/overview (official, MIT, byte-for-byte verified); search 2026-11-08",
    notes: "Duel V1 'Petunia': one tx launches two tokens + three pools with locked positions. DuelHook is shared by every duel's pools and carries an ANTI-SNIPE TAX (plus switch burn / realignment) — the honeypot buy+sell sim is the guard for our size, not this registry.",
    verified: "2026-11-08 eth_getCode: factory 22,918 / hook 21,753 bytes",
  },
  {
    id: "noxa", name: "Noxa", chains: [4663], poolTypes: ["V3", "V4"],
    addresses: {
      "4663": {  },
    },
    lpLocked: false, taxPersists: false, status: "dead", veto: false,
    source: "tools-and-sites Part 47 (gap check); Noxa halted 2026-07-11, dark 2026-07-13",
    notes: "VENUE-LEVEL FLAG, not a token verdict. Noxa was Robinhood's dominant launchpad (~$12M fees, ~60k launches) and went dark with NO fraud finding published. Lesson encoded here: a venue can fail without a fraud finding — so 'dead' means 'no +5, flag it', not 'veto every token'. No factory addresses are in our notes; if one surfaces, add it here with status dead.",
    verified: "no addresses — status-only entry",
  },
  // ---- Arc (5042) ----
  {
    id: "argus", name: "Argus (ArgusPad)", chains: [5042], poolTypes: ["V4"],
    addresses: {
      "5042": { portals: ["0xb021be536808f551b31789422fd28a6c9c6e97da", "0xa5628a11c412596e1f63b75a2c0284f843c549d6", "0x07a688a001f416cc433c68ff56aa26bc5131cc6e", "0xa36c443a797771df82533b8b4a86f0affd970862", "0x7a17ab0106c46c0be30623f3eb7f299cc0058338"] },
    },
    lpLocked: true, taxPersists: true, status: "live", veto: false,
    source: "tools-and-sites Part 38; research_notes/argus-launchpad-20261108-0250/report.md; builder.registrai.cc/ecosystem/argus (12 contracts, last reviewed 2026-10-20)",
    notes: "THE Arc launchpad. No bonding curve: full 1B supply into a single V4 position held by a locker with no withdrawal path, from block one. Per-launch hook charges a fixed buy/sell tax (creator-set; revenue split creator / buyback+burn / holder dividends / liquidity) — tax lives in the hook, so token checks pass and the sim shows reduced proceeds, not zero. The 5 portals above are the Registrai-listed 'Launch portal (v4)' contracts; 6 further addresses are attributed by the Arc indices without a role label — NOT registered (unknown role).",
    verified: "2026-11-08 eth_getCode: 23,845 / 22,023 / 20,652 / 24,324 / 24,202 bytes",
  },
  {
    id: "fairhatch", name: "FairHatch", chains: [4663], poolTypes: ["V4"],
    addresses: {
      "4663": {  },
    },
    lpLocked: true, taxPersists: false, status: "not-live", veto: false,
    source: "tools-and-sites Part 41; fairhatch.com guide (Medium)",
    notes: "NOT LIVE: contracts on Robinhood TESTNET since 2026-09-30; mainnet opens only after an independent audit. When live, graduates go to V4 (~$32k raised) with LP in an ownerless vault — visible to the v2 watcher then. Status-only entry until mainnet addresses publish.",
    verified: "no mainnet addresses — status-only entry",
  },
  // ---- Base (8453) ----
  // (Flap + o1 entries above already list 8453 in their chains.)
];

// KNOWN RUG — confirmed scams only. Veto is automatic for anything listed.
// Today: exactly two entries, both user-confirmed 2026-11-07 (~/MEMORY.md).
// The deployer list otherwise starts EMPTY on purpose — curation is
// conservative; a deployer with bad OUTCOMES belongs in memory.js
// (reputation ±25), not here. Never add on suspicion alone.
const KNOWN_RUG = {
  deployers: [
    {
      address: "0x333089e07fad944bc5d07f4679af7ace9efec932",
      reason: "Address-poisoning scammer: lookalike of the user's real wallet 0x3330Cbbb… (same 0x3330 prefix + c932 suffix); sent 5 fake 'POL' to the agent wallet 2026-11-07 19:19 GMT+7 (tx 0x20876649…). User confirmed 2026-11-07 ~19:40 GMT+7 they never sent it.",
      source: "~/MEMORY.md (FAKE POL entry); daily log 2026-11-07",
    },
  ],
  tokens: [
    {
      address: "0xe174c72d8f772838269a4dc5a88ce0cdfcbbc02b",
      reason: "Fake 'PỌL' token (spoof name: P + O-with-combining-dot + L), symbol POL, 18 dec. balanceOf()/totalSupply() REVERT onchain — unreadable/unusable, worth $0. Official POL is 0x455e53… (different address). Never approve, swap, or interact.",
      source: "~/MEMORY.md (FAKE POL entry); verified onchain 2026-11-07 ~19:27 GMT+7",
    },
    {
      address: "0x81adcf231fec5f8543629ed00a190b18b463662b",
      reason: "USER-BLOCKED 2026-11-09 ~23:08 GMT+7 (user: 'Block the BANK token' / 'Do not buy it again') — NOT a scam verdict: BANK passed every safety gate (GoPlus clean, holders clean, transfer-sim pass) on all 5 copy-buys. Blocked because every copy round trip loses ~$0.036 to gas (last one 23:03 GMT+7: bought 2,081.47 BANK for $0.02, mirror-sold at 0.81x, net -$0.036; real break-even 2.62x). The copy-trader and the v2 evaluator must never buy this token again.",
      source: "copy-trade-LOG.md 2026-11-09; user order in main chat 2026-11-09 ~23:08 GMT+7",
    },
  ],
};

// WATCHLIST — known launchpads / tokens with NO verified attribution
// address. Never scored, never vetoed. Listed so the next curation pass
// knows what is missing and why. Promote to LAUNCHPADS / KNOWN_RUG only
// with a verified address + official source.
const WATCHLIST = [
  {
    id: "pools-xyz", name: "Pools.xyz (Uniswap Labs)", chains: [4663, 5042], poolTypes: ["V4"],
    reason: "ATTRIBUTION IMPOSSIBLE BY RECEIPT.TO (verified onchain this session): each launch deploys its OWN launcher contract — HOOKR's V4 pool was created by a tx to 0x0000ffffbe8efe702c8703ae3477ff5de3d319c0 (4,127 bytes), FRONG's by a tx to 0x00004c4ccc709ef590f7c81102c0689f0263d4e9 (3,747 bytes), same function selector 0xac9650d8, different bytecode. Tokens are full 7,154-byte deployments of one template (same prefix, different code hash — embedded name/symbol differ), so no code-hash match either. Pools launches are the cleanest of the three big ones (V4, 0.25% LP fee, no tax hook, LP locked forever) — but the evaluator cannot prove one at T+0 without a factory trace (creation tx of the per-launch contract). Next step if wanted: resolve the deploying factory via an indexer (Blockscout API / Etherscan V2) and register THAT address.",
    source: "tools-and-sites Part 39; research_notes/pools-xyz-20261108-0255/report.md; onchain trace 2026-11-08 (HOOKR pool 0x590dcb… + FRONG pool 0xacea89…)",
  },
  {
    id: "robinlaunch", name: "Robinlaunch", chains: [4663], poolTypes: ["V3"],
    reason: "Live (bonding curve graduates at 2.5 ETH to V3 1%; Direct Pool / Boost launch instantly into V3, LP locked forever via LpFeeCollector, fees 70/30 bonding, 90/10 direct). BUT the how-it-works page names only versions — 'Factory v11', 'DirectFactory v8', 'BoostFactory' — no addresses. Nothing verifiable to register.",
    source: "tools-and-sites Part 41; robinlaunch.fun/how-it-works (read 2026-11-08)",
  },
  {
    id: "zecdock", name: "ZECDock", chains: [4663], poolTypes: ["V3"],
    reason: "Live; curve -> full-range V3, 1B supply, LP locked forever. Pairs with wrapped ZEC (zZEC), which is NOT in our quote allowlist — invisible to the watchers even with working V3 execution. Niche; note and move on.",
    source: "tools-and-sites Part 41; zecdock.family",
  },
  {
    id: "pons-copycat", name: "Second PONS copycat (watch only)",
    chains: [4663],
    reason: "Token 0xe306c19C72131B0a8f311648fa63FE8CeDf44571 is also named Pons / symbol PONS — different contract from the real PONS 0x39dBED3a2bd333467115dE45665cC57F813C4571. Verify by address, never by name. NOT vetoed (same-name is not proof of a rug); the no-impersonation check is the guard. Listed so it is not mistaken for the real token.",
    source: "tools-and-sites Part 36; research_notes/pons-launchpad-20261108-0243/report.md",
    token: "0xe306c19C72131B0a8f311648fa63FE8CeDf44571",
  },
];

const REGISTRY = { version: REGISTRY_VERSION, launchpads: LAUNCHPADS, knownRug: KNOWN_RUG, watchlist: WATCHLIST };

// ---- Pure lookups (data passed in — testable with synthetic/corrupt data) ----

// Addresses are matched PER CHAIN ONLY. This is load-bearing, not style:
// the same address can host a DIFFERENT contract on another chain
// (verified 2026-11-08: the Arc o1 Standard factory 0xeE3E862E... hosts a
// 4,214-byte contract on Robinhood, not the 24,466-byte factory; the
// Robinhood Flap Portal hosts a 3,068-byte contract on Base, not the
// 2,840-byte proxy). Matching an address on a chain it was not verified
// for would misattribute pools. Entry.addresses is keyed by chain id.
function _chainAddrs(entry, chainId) {
  if (!entry || typeof entry.addresses !== "object" || !entry.addresses) return { factories: [], portals: [], hooks: [], migrators: [], lockers: [] };
  const m = entry.addresses[String(chainId)] || entry.addresses[Number(chainId)] || {};
  const low = (xs) => (Array.isArray(xs) ? xs : []).map((a) => String(a).toLowerCase());
  return {
    factories: low(m.factories), portals: low(m.portals), hooks: low(m.hooks),
    migrators: low(m.migrators), lockers: low(m.lockers),
  };
}
function _addrs(entry, chainId) {
  // Addresses matchable against a pool-creation tx `to`.
  const c = _chainAddrs(entry, chainId);
  return [...c.factories, ...c.portals];
}
function _hooks(entry, chainId) {
  return _chainAddrs(entry, chainId).hooks;
}
function _lockers(entry, chainId) {
  return _chainAddrs(entry, chainId).lockers;
}

function _registryOk(data) {
  return data && typeof data === "object" && Array.isArray(data.launchpads) && data.knownRug && typeof data.knownRug === "object";
}

// Match a pool against the launchpad registry. Pure: pass data explicitly.
// input: { txTo, hooks, lpOwner } — any may be null (unknown).
// Returns { launchpad, matchedBy, evidence }. matchedBy: "factory" |
// "portal" | "hook" | "locker" | null. Never throws on bad data.
function matchLaunchpad(data, chainId, input) {
  const none = { launchpad: null, matchedBy: null, evidence: "no launchpad registry data" };
  try {
    if (!_registryOk(data)) return none;
    const inpt = input || {};
    const txTo = (inpt.txTo || "").toLowerCase() || null;
    const hooks = (inpt.hooks || "").toLowerCase() || null;
    const lpOwner = (inpt.lpOwner || "").toLowerCase() || null;
    const cid = Number(chainId);
    for (const entry of data.launchpads) {
      if (!entry || !Array.isArray(entry.chains) || !entry.chains.includes(cid)) continue;
      const c = _chainAddrs(entry, cid);
      if (txTo && [...c.factories, ...c.portals].includes(txTo)) {
        const kind = c.factories.includes(txTo) ? "factory" : "portal";
        return { launchpad: entry, matchedBy: kind, evidence: `pool-creation tx sent TO ${entry.name} ${kind} ${txTo} (chain ${cid})` };
      }
      if (hooks && c.hooks.includes(hooks)) {
        return { launchpad: entry, matchedBy: "hook", evidence: `pool hook is ${entry.name} hook ${hooks} (chain ${cid})` };
      }
      if (lpOwner && c.lockers.includes(lpOwner)) {
        return { launchpad: entry, matchedBy: "locker", evidence: `LP position held by ${entry.name} locker ${lpOwner} (chain ${cid})` };
      }
    }
    return { launchpad: null, matchedBy: null, evidence: "no registered launchpad matched (tx to " + (txTo || "?") + (hooks ? ", hook " + hooks : "") + (lpOwner ? ", LP owner " + lpOwner : "") + ")" };
  } catch {
    return none;
  }
}

// Score the launchpad-provenance component. Pure.
// Returns { points, detail, veto, launchpad }. Points are 0 or 5 only;
// a matched-but-untrusted launchpad is 0, never negative. veto is true
// only when the matched entry sets veto: true (none do today).
function scoreLaunchpad(data, chainId, input) {
  try {
    if (!_registryOk(data)) return { points: 0, detail: "launchpad registry unavailable (fail-open)", veto: false, launchpad: null };
    const m = matchLaunchpad(data, chainId, input);
    if (!m.launchpad) return { points: 0, detail: m.evidence + " — unknown launchpad is not a penalty", veto: false, launchpad: null };
    const e = m.launchpad;
    if (e.veto === true) return { points: 0, detail: `${e.name} is flagged VETO in the registry (${e.status}) — ${m.evidence}`, veto: true, launchpad: e };
    if ((e.status === "live" || e.status === "dormant") && e.lpLocked) {
      return { points: 5, detail: `${e.name} launch (${e.status}, LP locked) — ${m.evidence}${e.taxPersists ? " — NOTE: launchpad tax persists after graduation, sim is the guard" : ""}`, veto: false, launchpad: e };
    }
    return { points: 0, detail: `${e.name} matched (${e.status}) but scores 0 — ${e.status === "not-live" ? "not live yet" : e.status === "dead" ? "venue is dead (see Noxa lesson)" : "untrusted status"} — ${m.evidence}`, veto: false, launchpad: e };
  } catch {
    return { points: 0, detail: "launchpad registry lookup failed (fail-open)", veto: false, launchpad: null };
  }
}

// Check the known-rug registry. Pure.
// input: { deployer, token } — either may be null.
// Returns { veto, reason }. Only CONFIRMED entries veto.
function checkKnownRug(data, input) {
  const no = { veto: false, reason: "" };
  try {
    if (!_registryOk(data)) return no;
    const inpt = input || {};
    const deployer = (inpt.deployer || "").toLowerCase() || null;
    const token = (inpt.token || "").toLowerCase() || null;
    const deps = Array.isArray(data.knownRug.deployers) ? data.knownRug.deployers : [];
    const toks = Array.isArray(data.knownRug.tokens) ? data.knownRug.tokens : [];
    if (deployer) {
      const hit = deps.find((d) => d && String(d.address || "").toLowerCase() === deployer);
      if (hit) return { veto: true, reason: "deployer " + deployer + " is on the known-rug list — " + (hit.reason || "confirmed scam") };
    }
    if (token) {
      const hit = toks.find((t) => t && String(t.address || "").toLowerCase() === token);
      if (hit) return { veto: true, reason: "token " + token + " is on the known-rug list — " + (hit.reason || "confirmed scam") };
    }
    return no;
  } catch {
    return no;
  }
}

// ---- Convenience wrappers over the embedded curated registry ----

function matchLaunchpadLive(chainId, input) {
  return matchLaunchpad(REGISTRY, chainId, input);
}
function scoreLaunchpadLive(chainId, input) {
  return scoreLaunchpad(REGISTRY, chainId, input);
}
function checkKnownRugLive(input) {
  return checkKnownRug(REGISTRY, input);
}

module.exports = {
  REGISTRY_VERSION, REGISTRY, LAUNCHPADS, KNOWN_RUG, WATCHLIST,
  matchLaunchpad, scoreLaunchpad, checkKnownRug,
  matchLaunchpadLive, scoreLaunchpadLive, checkKnownRugLive,
};
