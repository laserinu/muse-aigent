// MuseLinu CREATE2 vanity grinder.
// Finds a bytes32 salt such that the Arachnid deterministic deployment proxy
// (0x4e59b44847b379578588920cA78FbF26c0B4956C) deploys the given init code at
// an address starting with 0x0000000f (7 zeros + f, 8 hex chars = 32 bits).
//
// CREATE2 address = keccak256(0xff ++ factory ++ salt ++ initCodeHash)[12:]
//
// Usage:
//   node grind.js <name> <initCodeHash> [workers] [startOffset]
//   e.g. node grind.js MuseLinuToken 0x9f12... 4
//
// Writes the result to ../grinder/<name>.salt.json when found, and logs
// progress (hashes/sec) to stderr every 10s.
const keccak = require("keccak");
const fs = require("fs");
const path = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const FACTORY = "4e59b44847b379578588920cA78FbF26c0B4956C"; // Arachnid proxy (no 0x)
const PREFIX = Buffer.concat([Buffer.from([0xff]), Buffer.from(FACTORY, "hex")]); // 21 bytes

// Target: first 4 address bytes == 00 00 00 0f  (i.e. address starts 0x0000000f)
function matches(hash) {
  return hash[12] === 0x00 && hash[13] === 0x00 && hash[14] === 0x00 && hash[15] === 0x0f;
}

function grind(name, initCodeHashHex, workerIndex, workerCount, startOffset) {
  const initHash = Buffer.from(initCodeHashHex.replace(/^0x/, ""), "hex");
  let salt = BigInt(startOffset) + BigInt(workerIndex);
  const step = BigInt(workerCount);
  const saltBuf = Buffer.alloc(32);
  const input = Buffer.alloc(85); // 1 + 20 + 32 + 32
  PREFIX.copy(input, 0);
  initHash.copy(input, 53);
  let count = 0;
  let lastReport = Date.now();
  while (true) {
    // salt as 32-byte big-endian at bytes 21..53
    let s = salt;
    for (let i = 31; i >= 0; i--) {
      saltBuf[i] = Number(s & 0xffn);
      s >>= 8n;
    }
    saltBuf.copy(input, 21);
    const hash = keccak("keccak256").update(input).digest();
    count++;
    if (matches(hash)) {
      const address = "0x" + hash.subarray(12).toString("hex");
      return { name, address, salt: "0x" + saltBuf.toString("hex"), tries: count, workerIndex };
    }
    salt += step;
    const now = Date.now();
    if (now - lastReport >= 10000) {
      parentPort.postMessage({ type: "progress", workerIndex, count, elapsedMs: now - lastReport });
      lastReport = now;
      count = 0;
    }
  }
}

if (isMainThread) {
  const [name, initCodeHashHex, workersArg, startArg] = process.argv.slice(2);
  if (!name || !initCodeHashHex) {
    console.error("Usage: node grind.js <name> <initCodeHash> [workers] [startOffset]");
    process.exit(1);
  }
  const workers = parseInt(workersArg || "4", 10);
  const startOffset = parseInt(startArg || "0", 10);
  const outDir = path.join(__dirname, "..", "grinder");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${name}.salt.json`);
  console.log(`Grinding ${name} (initCodeHash ${initCodeHashHex}) with ${workers} workers, target 0x0000000f...`);
  console.log(`Result will be written to ${outFile}`);

  let totalRate = 0;
  let lastTotal = Date.now();
  let found = false;
  const counts = new Array(workers).fill(0);
  for (let i = 0; i < workers; i++) {
    const w = new Worker(__filename, {
      workerData: { name, initCodeHashHex, workerIndex: i, workerCount: workers, startOffset },
    });
    w.on("message", (msg) => {
      if (msg.type === "progress") {
        counts[msg.workerIndex] += msg.count;
        const now = Date.now();
        if (now - lastTotal >= 30000) {
          const total = counts.reduce((a, b) => a + b, 0);
          const elapsed = (now - lastTotal) / 1000;
          console.log(`  ... ${total} hashes in ${elapsed.toFixed(0)}s (${(total / elapsed / 1e6).toFixed(2)} Mhash/s total)`);
          counts.fill(0);
          lastTotal = now;
        }
      }
    });
    w.on("error", (e) => console.error("worker error", e));
  }
  // The worker that finds it exits with the result via process exit code is
  // awkward with threads; instead each worker writes the file itself and we
  // poll for it. Simpler: workers post the result back.
  // (Implemented below via a second message type.)
  process.on("message", () => {});
  // Poll for the result file (workers write it directly on success).
  const poll = setInterval(() => {
    if (fs.existsSync(outFile)) {
      const res = JSON.parse(fs.readFileSync(outFile, "utf8"));
      console.log(`FOUND ${name}: address ${res.address} salt ${res.salt}`);
      clearInterval(poll);
      process.exit(0);
    }
  }, 2000);
} else {
  const { name, initCodeHashHex, workerIndex, workerCount, startOffset } = workerData;
  const result = grind(name, initCodeHashHex, workerIndex, workerCount, startOffset);
  const outDir = path.join(__dirname, "..", "grinder");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${name}.salt.json`), JSON.stringify(result, null, 2));
  console.log(`Worker ${workerIndex} FOUND ${name}: ${result.address} salt ${result.salt}`);
  process.exit(0);
}
