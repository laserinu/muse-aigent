// MUSN deploy preview generator.
// Reads the ground token + collector salts (grinder/*.salt.json), computes
// the CREATE2 addresses, mines the per-chain hook salt (HookMiner-style:
// the hook address must end in 0x00CC for flags 0xCC), and prints the full
// deploy preview: addresses, salts, constructor args, tx order, gas
// estimates, seed plan, sniper reserve left.
// Usage: node deploy-preview.js
// Requires: ../grinder/MuseLinuToken.salt.json + ../grinder/MuseLinuFeeCollector.salt.json
// Reads hook creation code from ../out/MuseLinuHook.sol/MuseLinuHook.json (paris build).
const fs = require("fs");
const path = require("path");
const { encodeAbiParameters, parseAbiParameters, keccak256, concat } = require("viem");

const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C"; // Arachnid deterministic deployment proxy
const DEAD = "0x000000000000000000000000000000000000dEaD";

// Per-chain V4 + quote addresses (verified 2026-11-09).
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
    tickLower: 189420, tickUpper: 193920,
  },
  polygon: {
    chainId: 137,
    poolManager: "0x67366782805870060151383F4BbFF9daB53e5cD6",
    positionManager: "0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9",
    quote: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WPOL
    quoteSymbol: "WPOL (native POL)",
    quoteDecimals: 18,
    seedQuote: 1980000000000000000n, // 1.98 POL = $0.25
    forkGas: 7853827,
    forkAmountNative: 0.060762316447820499, // POL, fork-reported
    nativeUsd: 0.126156,
    nativeSymbol: "POL",
    tickLower: 92220, tickUpper: 96660,
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
    tickLower: 389220, tickUpper: 393720,
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
    tickLower: -887220, tickUpper: 887220, // full range, like $RMUSE
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
    // Hook init code = creation + abi.encode(poolManager, quote, collector, token).
    const ctorArgs = encodeAbiParameters(
      parseAbiParameters("address,address,address,address"),
      [c.poolManager, c.quote, collectorAddr, tokenAddr]
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

    // Gas cost estimate — fork-reported native amount (with-automation run,
    // a conservative upper bound; the real deploy has no test swaps or
    // automation dry-run, so it costs less).
    const gasCostUsd = c.forkAmountNative * c.nativeUsd;

    console.log("--- " + name.toUpperCase() + " (chain " + c.chainId + ") ---");
    console.log("  token:     " + tokenAddr);
    console.log("  collector: " + collectorAddr);
    console.log("  hook:      " + hookAddr + "  salt " + hookSaltHex + " (flags 0xCC)");
    console.log("  hook initCodeHash: " + initCodeHash);
    console.log("  pool: MUSN/" + c.quoteSymbol + " fee 3000, hook 0xCC, ticks [" + c.tickLower + ", " + c.tickUpper + "]");
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
  console.log("  (Polygon 5 base units, Base ~104.6B, Arc ~229B). Recommend burning");
  console.log("  the dust to the dead address after seeding so deployer holds 0.");
}

main();
