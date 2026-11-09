// MUSN deploy preview generator.
// Reads the ground token + collector salts (grinder/*.salt.json), computes
// the CREATE2 addresses, mines the per-chain hook salt (HookMiner-style:
// the hook address must end in 0x00CC for flags 0xCC), and prints the full
// deploy preview: addresses, salts, constructor args, tx order, gas
// estimates, seed plan, sniper reserve left.
// Usage: node deploy-preview.js
// Requires: ../grinder/MuseLinuToken.salt.json + ../grinder/MuseLinuFeeCollector.salt.json
// Reads hook creation code from ../out/MuseLinuHook.sol/MuseLinuHook.json (paris build).
//
// HOOK CONSTRUCTOR — the single source of truth is src/MuseLinuHook.sol:91:
//   (IPoolManager _poolManager, address _token, address _quote,
//    address _collector, uint24 _fee, int24 _tickSpacing)
// with _fee = 3000, _tickSpacing = 60. The fork test
// (script/ForkDeployTest.s.sol) and the calldata builder
// (script/BuildDeployCalldata.s.sol) encode exactly this order. Any
// deviation here produces hook addresses that can never exist onchain —
// that is what happened to the first preview (it encoded 4 addresses in
// the wrong order and omitted fee/tickSpacing, and the mainnet deploy
// correctly stopped at pre-flight with $0 spent).
// BEFORE calling a regenerated preview FINAL, cross-check: the hook
// initCodeHash printed per chain below MUST equal the forge-computed one
// (BuildDeployCalldata's require(hook == expectedHook) passing on all four
// chains, plus an independent cast/Node recomputation). See report §12.
const fs = require("fs");
const path = require("path");
const { encodeAbiParameters, parseAbiParameters, keccak256, concat } = require("viem");

const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C"; // Arachnid deterministic deployment proxy
const DEAD = "0x000000000000000000000000000000000000dEaD";

// Per-chain V4 + quote addresses (verified 2026-11-09).
// Tick ranges are DERIVED below from the seed ratio with the VANITY token
// address (see tickRange()). Never copy ticks from the salt-0 fork runs:
// the salt-0 token (0xDC32...) is ABOVE the WETH/USDC quotes, the vanity
// token (0x0000000f...) is BELOW them, so the currency order — and the
// tick sign — flips on Base and Arc. The first preview carried the stale
// salt-0 ticks [189420, 193920] / [389220, 393720]; the correct ranges are
// negative ([-193920, -189420] / [-393720, -389220]). Polygon flipped too
// when the quote switched from native POL (address(0), token always above
// it) to WPOL (0x0d50..., token below it): its range is now negative
// ([-96720, -92220]), DERIVED the same way. See report §12-13.
const MUSN_AMOUNT = 25_000_000_000_000n * 1_000_000_000n; // 25T, 9 dec
const CHAINS = {
  base: {
    chainId: 8453,
    poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    positionManager: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
    quote: "0x4200000000000000000000000000000000000006", // WETH
    quoteSymbol: "WETH",
    quoteDecimals: 18,
    seedQuote: 118700000000000n, // 0.0001187 ETH = $0.25
    forkGas: 8771212, // with-automation fork total (conservative upper bound)
    forkAmountNative: 0.000084129071126788, // ETH, fork-reported "amount required"
    nativeUsd: 2105.74,
    nativeSymbol: "ETH",
  },
  polygon: {
    chainId: 137,
    poolManager: "0x67366782805870060151383F4BbFF9daB53e5cD6",
    positionManager: "0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9",
    quote: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WPOL ("Wrapped Polygon Ecosystem Token", verified onchain; was native POL — Polygon pools standardly use WPOL, report §13)
    quoteSymbol: "WPOL",
    quoteDecimals: 18,
    seedQuote: 1980000000000000000n, // 1.98 WPOL = $0.25 (agent holds 2.2667 WPOL; the deploy JSON also wraps 1.98 POL as a fallback)
    forkGas: 8814289, // WPOL fork total (with-automation; native-POL run was 7,853,827)
    forkAmountNative: 0.068193075487981, // POL, fork-reported (same ~7.74 gwei implied price as the approved preview)
    nativeUsd: 0.126156,
    nativeSymbol: "POL",
  },
  arc: {
    chainId: 5042,
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    positionManager: "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B",
    quote: "0x3600000000000000000000000000000000000000", // USDC (native gas)
    quoteSymbol: "USDC",
    quoteDecimals: 6,
    seedQuote: 250000n, // 0.25 USDC
    forkGas: 9335542,
    forkAmountNative: 0.006865875083899686, // USDC, fork-reported
    nativeUsd: 1,
    nativeSymbol: "USDC",
  },
  robinhood: {
    chainId: 4663,
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
    quote: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // WETH
    quoteSymbol: "WETH",
    quoteDecimals: 18,
    seedQuote: 118700000000000n, // 0.0001187 ETH = $0.25
    forkGas: 8771212, // fallback: same shape as Base (Robinhood fork blocked by RPC)
    forkAmountNative: 0.000084129071126788, // ETH, Base-shape upper bound
    nativeUsd: 2105.74,
    nativeSymbol: "ETH",
    fullRange: true, // full range, like $RMUSE
  },
};

// Sniper reserve left after the seeds (hard constraint).
const RESERVE = {
  base: "0.00035 ETH (~$0.74) — covers ~5 sniper buys + gas",
  polygon: "3.37 POL (~$0.43) after the 0.16 POL setAgentURI reserve — ~21 buys",
  arc: "0.568 USDC — ~20 buys",
  robinhood: "0.0001 ETH (~$0.21) — ~5-6 copy-buys, tight",
};

function keccakHex(buf) {
  return keccak256(buf);
}

function create2Address(factory, saltHex, initCodeHashHex) {
  return "0x" + keccak256(concat(["0xff", factory, saltHex, initCodeHashHex])).slice(26);
}

function readSalt(name) {
  const p = path.join(__dirname, "..", "grinder", name + ".salt.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return j;
}

function floorToSpacing(tick, spacing) {
  const r = tick % spacing; // JS % follows the dividend's sign, like Solidity
  if (r === 0) return tick;
  if (tick < 0) return tick - (spacing + r);
  return tick - r;
}

function ceilToSpacing(tick, spacing) {
  const r = tick % spacing;
  if (r === 0) return tick;
  if (tick < 0) return tick - r;
  return tick + (spacing - r);
}

// Concentrated tick range (±2220 ticks around the seed tick, snapped to
// spacing 60) — the same computation as _tickRange in
// script/ForkDeployTest.s.sol and script/BuildDeployCalldata.s.sol.
// The seed price is quote-per-MUSN when the token is currency0
// (token < quote) and MUSN-per-quote otherwise; the ORDER DEPENDS ON THE
// VANITY TOKEN ADDRESS, which is why this is computed, never hardcoded.
// Double precision is ample here (tick error << 1; the spacing snap
// absorbs it, and verify-preview.js checks the result against the
// forge-computed deploy-<chain>.json).
function tickRange(tokenAddr, quoteAddr, seedQuote, fullRange) {
  if (fullRange) return [-887220, 887220];
  const price = tokenAddr.toLowerCase() < quoteAddr.toLowerCase()
    ? Number(seedQuote) / Number(MUSN_AMOUNT)
    : Number(MUSN_AMOUNT) / Number(seedQuote);
  const tick = Math.floor(Math.log(price) / Math.log(1.0001));
  return [floorToSpacing(tick - 2220, 60), ceilToSpacing(tick + 2220, 60)];
}

function main() {
  const tokenSalt = readSalt("MuseLinuToken");
  const collectorSalt = readSalt("MuseLinuFeeCollector");
  const tokenAddr = tokenSalt.address;
  const collectorAddr = collectorSalt.address;
  console.log("=== MUSN DEPLOY PREVIEW ===");
  console.log("Token:    " + tokenAddr + "  salt " + tokenSalt.salt);
  console.log("Collector:" + collectorAddr + "  salt " + collectorSalt.salt);
  console.log("Factory:  " + FACTORY + " (Arachnid deterministic deployment proxy)");
  console.log("Owner:    " + AGENT);
  console.log("");

  // Hook creation code (paris build). Strip the 0x prefix — Buffer.from
  // with a leading 0x silently returns an EMPTY buffer (the same gotcha as
  // the token/collector init-code hashes), which would make every chain's
  // hook hash equal keccak256("") and every hook address identical.
  const hookArtifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "out", "MuseLinuHook.sol", "MuseLinuHook.json"), "utf8")
  );
  const hookCreation = hookArtifact.bytecode.object.replace(/^0x/, "");

  for (const [name, c] of Object.entries(CHAINS)) {
    // Hook init code = creation + abi.encode(poolManager, token, quote,
    // collector, fee, tickSpacing) — the constructor order in
    // src/MuseLinuHook.sol:91. (The first preview encoded only 4 addresses
    // in the wrong order and omitted fee/tickSpacing; its hook addresses
    // were unreachable. Do not "simplify" this back.)
    const ctorArgs = encodeAbiParameters(
      parseAbiParameters("address,address,address,address,uint24,int24"),
      [c.poolManager, tokenAddr, c.quote, collectorAddr, 3000, 60]
    );
    const initCode = hookCreation + ctorArgs.slice(2);
    const initCodeHash = keccakHex(Buffer.from(initCode, "hex"));

    // Mine the hook salt: address must end in 0x00CC (flags 0xCC in the
    // last two bytes; bits 14-15 must be 0). ~16-bit search, fast.
    let hookSalt = 0n;
    let hookAddr = "";
    while (true) {
      const saltHex = "0x" + hookSalt.toString(16).padStart(64, "0");
      const addr = create2Address(FACTORY, saltHex, initCodeHash);
      if (addr.toLowerCase().endsWith("00cc")) {
        hookAddr = addr;
        break;
      }
      hookSalt++;
    }
    const hookSaltHex = "0x" + hookSalt.toString(16).padStart(64, "0");

    const [tickLower, tickUpper] = tickRange(tokenAddr, c.quote, c.seedQuote, !!c.fullRange);

    // Gas cost estimate — fork-reported native amount (with-automation run,
    // a conservative upper bound; the real deploy has no test swaps or
    // automation dry-run, so it costs less).
    const gasCostUsd = c.forkAmountNative * c.nativeUsd;

    console.log("--- " + name.toUpperCase() + " (chain " + c.chainId + ") ---");
    console.log("  token:     " + tokenAddr);
    console.log("  collector: " + collectorAddr);
    console.log("  hook:      " + hookAddr + "  salt " + hookSaltHex + " (flags 0xCC)");
    console.log("  hook initCodeHash: " + initCodeHash);
    console.log("  pool: MUSN/" + c.quoteSymbol + " fee 3000, hook 0xCC, ticks [" + tickLower + ", " + tickUpper + "]");
    console.log("  seed: 25T MUSN + " + c.seedQuote.toString() + " " + c.quoteSymbol + " base units (~$0.25)");
    console.log("  deploy tx order:");
    console.log("    1. CREATE2 token (salt " + tokenSalt.salt + ")");
    console.log("    2. CREATE2 collector (salt " + collectorSalt.salt + ")");
    console.log("    3. CREATE2 hook (salt " + hookSaltHex + ")");
    console.log("    4. initialize pool (MUSN/" + c.quoteSymbol + ", fee 3000, hook)");
    console.log("    5. approve MUSN + quote to Permit2, mint seed position (25T + quote)");
    console.log("    6. (recommended) burn leftover seed MUSN dust to dead address");
    console.log("  gas estimate: ~" + c.forkGas.toLocaleString() + " gas (fork, with-automation upper bound) = " +
      c.forkAmountNative.toFixed(6) + " " + c.nativeSymbol + " (~$" + gasCostUsd.toFixed(4) + ")");
    console.log("  sniper reserve left: " + RESERVE[name]);
    console.log("");
  }

  console.log("=== OPEN DECISIONS (need the user) ===");
  console.log("- Supply 100T / 25T per chain / 9 decimals: UNCONFIRMED by the user.");
  console.log("- Automation threshold: proposed $0.05 of fees per chain (see report).");
  console.log("- Bridge choice (Relay vs lock/release): open.");
  console.log("- MAINNET GO: NOT authorized — this preview is for the user's final go.");
  console.log("- Dust: the concentrated seed leaves MUSN dust with the deployer");
  console.log("  (Polygon ~620.7B, Base ~104.6B, Arc ~229B). Recommend burning");
  console.log("  the dust to the dead address after seeding so deployer holds 0.");
}

main();
