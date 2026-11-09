// MEV pre-init check for the MUSN deploy.
// Before initializing a pool, verify it is NOT already initialized
// (a bot could pre-initialize our public pool key at a bad price —
// griefing that makes our seed tx revert). Reads the V4 PoolManager
// pool state via extsload and confirms it is empty.
//   slot0 slot = keccak256(abi.encode(poolId, 6))
//   liquidity slot = slot0 slot + 3
// (Established from the $MUSE pool reads; see report §4.)
// Usage: node tools/check-pool-init.js <base|polygon|arc|robinhood>
//   Reads tools/deploy-<chain>.json for the pool key.
//   Exit 0 = pool NOT initialized (safe to seed). Exit 1 = pool IS
//   initialized (STOP that chain — do not seed into it).
//   Env override for validation: CHECK_POOL_ID=0x... (reads that poolId
//   directly instead of deriving it from the deploy JSON).
const fs = require("fs");
const path = require("path");
const { keccak256, encodeAbiParameters, parseAbiParameters, createPublicClient, http } = require("viem");

const RPCS = {
  base: "https://base-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  arc: "https://rpc.blockdaemon.mainnet.arc.io",
  robinhood: "https://rpc.mainnet.chain.robinhood.com",
};

const EXTSLOAD_ABI = [
  { type: "function", name: "extsload", stateMutability: "view", inputs: [{ name: "slot", type: "bytes32" }], outputs: [{ name: "", type: "bytes32" }] },
];

async function main() {
  const chain = process.argv[2];
  if (!RPCS[chain]) {
    console.error("usage: node tools/check-pool-init.js <base|polygon|arc|robinhood>");
    process.exit(2);
  }
  const dj = JSON.parse(fs.readFileSync(path.join(__dirname, "deploy-" + chain + ".json"), "utf8"));
  const poolManager = dj.poolManager;
  let poolId;
  if (process.env.CHECK_POOL_ID) {
    poolId = process.env.CHECK_POOL_ID;
  } else {
    const token = dj.token.toLowerCase();
    const quote = dj.quote.toLowerCase();
    const c0 = token < quote ? token : quote;
    const c1 = token < quote ? quote : token;
    poolId = keccak256(
      encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [c0, c1, 3000, 60, dj.hook])
    );
  }
  const slot = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,uint256"), [poolId, 6n]));
  const liqSlot = "0x" + (BigInt(slot) + 3n).toString(16).padStart(64, "0");

  const client = createPublicClient({ transport: http(RPCS[chain]) });
  const slot0 = await client.readContract({ address: poolManager, abi: EXTSLOAD_ABI, functionName: "extsload", args: [slot] });
  const liq = await client.readContract({ address: poolManager, abi: EXTSLOAD_ABI, functionName: "extsload", args: [liqSlot] });
  console.log(chain + " poolId: " + poolId);
  console.log(chain + " slot0: " + slot0);
  console.log(chain + " liquidity: " + liq);
  if (BigInt(slot0) === 0n && BigInt(liq) === 0n) {
    console.log(chain + ": pool NOT initialized — safe to seed");
    process.exit(0);
  }
  // Decode slot0: sqrtPriceX96 (low 160 bits) | tick (next 24, signed) | protocolFee (24) | lpFee (24).
  const v = BigInt(slot0);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & ((1n << 24n) - 1n));
  if (tick >= 1 << 23) tick -= 1 << 24;
  console.log(chain + ": pool ALREADY INITIALIZED — sqrtPriceX96 " + sqrtPriceX96 + " tick " + tick + " — DO NOT SEED");
  process.exit(1);
}

main().catch((e) => {
  console.error("check-pool-init error: " + (e && e.message ? e.message : e));
  process.exit(2);
});
