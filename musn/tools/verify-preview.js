// Independent verification for the MUSN deploy preview.
// Deliberately does NOT import tools/deploy-preview.js: the constructor
// encoding and per-chain values are hardcoded here from the verified
// sources (src/MuseLinuHook.sol:91 for the arg order; the fork test /
// BuildDeployCalldata for the per-chain poolManager + quote), so a bug in
// the generator cannot hide behind a shared module.
// Usage: node tools/verify-preview.js
// Exit 0 = every check passed; non-zero = the preview is NOT final.
const fs = require("fs");
const path = require("path");
const { encodeAbiParameters, parseAbiParameters, keccak256, concat } = require("viem");

const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const TOKEN_SALT = "0x00000000000000000000000000000000000000000000000000000000ff37a90a";
const COLLECTOR_SALT = "0x00000000000000000000000000000000000000000000000000000001e52c2dc6";
const EXPECTED_TOKEN = "0x0000000fc9a3c921ca909d84ae404a9ccaef4479";
const EXPECTED_COLLECTOR = "0x0000000f64352eb1bacef4d9d5cae00f505a149e";
const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";

// Per-chain values, hardcoded from the verified onchain config
// (fork test _cfg + BuildDeployCalldata _cfg). Polygon quote is WPOL
// 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270 ("Wrapped Polygon Ecosystem
// Token" / WPOL, verified onchain) — NOT native POL; the hook's quote
// identifies the pool currency. Polygon pools standardly use WPOL
// (report §13); the native-POL preview was corrected to WPOL.
const CHAINS = {
  base: { poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b", quote: "0x4200000000000000000000000000000000000006" },
  polygon: { poolManager: "0x67366782805870060151383F4BbFF9daB53e5cD6", quote: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" },
  arc: { poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951", quote: "0x3600000000000000000000000000000000000000" },
  robinhood: { poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951", quote: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" },
};

function create2(factory, saltHex, initCodeHashHex) {
  return "0x" + keccak256(concat(["0xff", factory, saltHex, initCodeHashHex])).slice(26);
}

function fail(msg) {
  console.error("VERIFY FAIL: " + msg);
  process.exitCode = 1;
}

const root = path.join(__dirname, "..");
const preview = fs.readFileSync(path.join(root, "deploy-preview.txt"), "utf8");

// Token + collector: reproduce CREATE2 addresses from ground salts.
const tokenArtifact = JSON.parse(fs.readFileSync(path.join(root, "out", "MuseLinuToken.sol", "MuseLinuToken.json"), "utf8"));
const collectorArtifact = JSON.parse(fs.readFileSync(path.join(root, "out", "MuseLinuFeeCollector.sol", "MuseLinuFeeCollector.json"), "utf8"));
const tokenInit = tokenArtifact.bytecode.object.replace(/^0x/, "") + encodeAbiParameters(parseAbiParameters("address"), [AGENT]).slice(2);
const collectorInit = collectorArtifact.bytecode.object.replace(/^0x/, "") + encodeAbiParameters(parseAbiParameters("address"), [AGENT]).slice(2);
const tokenAddr = create2(FACTORY, TOKEN_SALT, keccak256(Buffer.from(tokenInit, "hex")));
const collectorAddr = create2(FACTORY, COLLECTOR_SALT, keccak256(Buffer.from(collectorInit, "hex")));
console.log("token:     " + tokenAddr + (tokenAddr.toLowerCase() === EXPECTED_TOKEN.toLowerCase() ? " OK" : " MISMATCH"));
console.log("collector: " + collectorAddr + (collectorAddr.toLowerCase() === EXPECTED_COLLECTOR.toLowerCase() ? " OK" : " MISMATCH"));
if (tokenAddr.toLowerCase() !== EXPECTED_TOKEN.toLowerCase()) fail("token address does not reproduce");
if (collectorAddr.toLowerCase() !== EXPECTED_COLLECTOR.toLowerCase()) fail("collector address does not reproduce");

// Hook: parse the preview's per-chain hook address / salt / initCodeHash,
// recompute from the artifact + correct constructor encoding, compare.
const hookArtifact = JSON.parse(fs.readFileSync(path.join(root, "out", "MuseLinuHook.sol", "MuseLinuHook.json"), "utf8"));
const hookCreation = hookArtifact.bytecode.object.replace(/^0x/, "");
for (const [name, c] of Object.entries(CHAINS)) {
  const section = preview.split("--- " + name.toUpperCase() + " ")[1];
  if (!section) { fail(name + ": section missing from preview"); continue; }
  const addrM = section.match(/hook:\s+(0x[0-9a-fA-F]{40})/);
  const saltM = section.match(/salt (0x[0-9a-fA-F]{64})/);
  const hashM = section.match(/hook initCodeHash: (0x[0-9a-fA-F]{64})/);
  if (!addrM || !saltM || !hashM) { fail(name + ": could not parse hook/salt/hash from preview"); continue; }
  // Constructor encoding, straight from src/MuseLinuHook.sol:91.
  const ctorArgs = encodeAbiParameters(
    parseAbiParameters("address,address,address,address,uint24,int24"),
    [c.poolManager, EXPECTED_TOKEN, c.quote, EXPECTED_COLLECTOR, 3000, 60]
  );
  const initCode = hookCreation + ctorArgs.slice(2);
  const initCodeHash = keccak256(Buffer.from(initCode, "hex"));
  const addr = create2(FACTORY, saltM[1], initCodeHash);
  const okHash = initCodeHash.toLowerCase() === hashM[1].toLowerCase();
  const okAddr = addr.toLowerCase() === addrM[1].toLowerCase();
  const okFlags = addr.toLowerCase().endsWith("00cc") && (BigInt(addr) & 0x3fffn) === 0xccn;
  console.log(name + ": hash " + (okHash ? "OK" : "MISMATCH (" + initCodeHash + " vs preview " + hashM[1] + ")")
    + " | addr " + (okAddr ? "OK" : "MISMATCH (" + addr + " vs preview " + addrM[1] + ")")
    + " | flags " + (okFlags ? "0x00CC OK" : "BAD"));
  if (!okHash) fail(name + ": hook initCodeHash mismatch vs preview");
  if (!okAddr) fail(name + ": hook CREATE2 address mismatch vs preview");
  if (!okFlags) fail(name + ": hook address does not end 0x00CC / flags not 0xCC");

  // Ticks: the preview's range must equal the forge-computed one in
  // tools/deploy-<chain>.json (BuildDeployCalldata). This catches stale
  // salt-0 ticks — the first preview carried [189420, 193920] / [389220,
  // 393720] for Base/Arc, but the vanity token flips the currency order
  // and the correct ranges are negative.
  const ticksM = section.match(/ticks \[(-?\d+), (-?\d+)\]/);
  const deployJson = JSON.parse(fs.readFileSync(path.join(root, "tools", "deploy-" + name + ".json"), "utf8"));
  const okTicks = ticksM && parseInt(ticksM[1], 10) === deployJson.tickLower && parseInt(ticksM[2], 10) === deployJson.tickUpper;
  const okJsonHook = deployJson.hook.toLowerCase() === addrM[1].toLowerCase();
  console.log(name + ": ticks " + (okTicks ? "OK [" + deployJson.tickLower + ", " + deployJson.tickUpper + "]" : "MISMATCH (preview [" + (ticksM ? ticksM[1] + ", " + ticksM[2] : "?") + "] vs forge [" + deployJson.tickLower + ", " + deployJson.tickUpper + "])")
    + " | deploy-json hook " + (okJsonHook ? "OK" : "MISMATCH"));
  if (!okTicks) fail(name + ": tick range mismatch vs forge deploy JSON");
  if (!okJsonHook) fail(name + ": deploy JSON hook mismatch vs preview");
}

if (process.exitCode) console.error("PREVIEW NOT FINAL — see failures above");
else console.log("PREVIEW VERIFIED: all chains reproduce, all hooks end 0x00CC");
