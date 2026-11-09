// chains.js — Sniper v2 chain-agnostic layer.
//
// Every EVM chain is added by config alone (config.json -> chains[<chainId>]).
// No chain id, RPC URL, or contract address is hardcoded here.
//
// Key v1 lessons carried over:
//  - viem client.getLogs({ topics }) SILENTLY IGNORES the topic filter on some
//    RPCs (proven on Robinhood). All log scans use RAW eth_getLogs JSON-RPC.
//  - PoolManager differs per chain (only Robinhood + Arc share 0x8366...).
//  - V4Quoter differs per chain (0x8Dc1... has NO code on Base/Polygon).
//  - Arc's main RPC returns 0 for eth_getLogs — use the per-chain logsRpc.

const { createPublicClient, http, parseAbi } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");

const POOL_MANAGER_ABI = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "function extsload(bytes32 slot) view returns (bytes32)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address,address,uint24,int24,address) params, uint256 amountIn) returns (uint256 amountOut, uint256 gasEstimate)",
]);

// V4 PoolManager Initialize event topic0 (V4 only — Phase 1).
// V3 PoolCreated 0x783cca1c... and V2 PairCreated 0x0d3648bd... are Phase 2.
const INITIALIZE_TOPIC0 = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

function loadConfig() {
  return require("./config.json");
}

// Enabled Phase 1 chains, in config order (Robinhood -> Base -> Arc -> Polygon).
function enabledChains(cfg) {
  return Object.entries(cfg.chains)
    .filter(([, c]) => c.enabled === true)
    .map(([id, c]) => ({ chainId: Number(id), ...c }));
}

function makeClient(chain) {
  return createPublicClient({ transport: http(chain.logsRpc || chain.rpc) });
}

// Raw eth_getLogs — the ONLY log scan path. Never use client.getLogs here.
// Chunked into <=5000-block ranges: the Polygon publicnode RPC rejects any
// eth_getLogs over 10000 blocks ("exceed maximum block range"), so a single
// call would fail outright after ~5.5h of watcher downtime and never advance
// lastScannedBlock (fixed 2026-11-07 — a 20000-block dry-run scan proved it).
async function rawGetLogs(client, { address, topics, fromBlock, toBlock }) {
  const rpcUrl = client.transport.url;
  const CHUNK = 5000n;
  const out = [];
  for (let start = BigInt(fromBlock); start <= BigInt(toBlock); start += CHUNK) {
    const end = start + CHUNK - 1n > BigInt(toBlock) ? BigInt(toBlock) : start + CHUNK - 1n;
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [{ address, topics, fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16) }],
    };
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`eth_getLogs HTTP ${res.status} on ${rpcUrl}`);
    const json = await res.json();
    if (json.error) throw new Error(`eth_getLogs RPC error: ${JSON.stringify(json.error)}`);
    out.push(...(json.result || []));
  }
  return out;
}

// Decode one Initialize log into a pool record.
// Event: Initialize(bytes32 indexed id, address indexed currency0,
//   address indexed currency1, uint24 fee, int24 tickSpacing, address hooks,
//   uint160 sqrtPriceX96, int24 tick)
// topics[0]=topic0, topics[1]=poolId, topics[2]=currency0, topics[3]=currency1.
// data = fee, tickSpacing, hooks, sqrtPriceX96, tick (5 words).
function decodeInitialize(log) {
  const { decodeAbiParameters } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
  const [fee, tickSpacing, hooks, sqrtPriceX96] = decodeAbiParameters(
    [{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }],
    log.data,
  );
  return {
    poolId: log.topics[1].toLowerCase(),
    currency0: ("0x" + log.topics[2].slice(26)).toLowerCase(),
    currency1: ("0x" + log.topics[3].slice(26)).toLowerCase(),
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    hooks: hooks.toLowerCase(),
    sqrtPriceX96,
    blockNumber: Number(log.blockNumber),
    txHash: log.transactionHash,
    logIndex: Number(log.logIndex),
  };
}

// Scan one chain's PoolManager for new Initialize events in [fromBlock, toBlock].
async function scanNewPools(chain, fromBlock, toBlock) {
  const client = makeClient(chain);
  const logs = await rawGetLogs(client, {
    address: chain.poolManager,
    topics: [INITIALIZE_TOPIC0],
    fromBlock,
    toBlock,
  });
  return logs.map(decodeInitialize);
}

// Read token metadata. Returns null if the address is not a readable ERC-20.
async function readToken(client, address) {
  try {
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      client.readContract({ address, abi: ERC20_ABI, functionName: "name" }),
      client.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }),
      client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }),
      client.readContract({ address, abi: ERC20_ABI, functionName: "totalSupply" }),
    ]);
    return { address: address.toLowerCase(), name, symbol, decimals, totalSupply };
  } catch {
    return null;
  }
}

// Read pool state (sqrtPriceX96, tick, lpFee) + active liquidity via
// PoolManager extsload / StateLibrary.
// V4 pool state slot = keccak256(poolId || POOLS_SLOT=6); liquidity is slot+3.
async function readPoolState(client, poolManager, poolId) {
  const { keccak256, encodePacked } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
  const slot = keccak256(encodePacked(["bytes32", "uint256"], [poolId, 6n]));
  const liqSlot = "0x" + (BigInt(slot) + 3n).toString(16).padStart(64, "0");
  const [raw, rawLiq] = await Promise.all([
    client.readContract({ address: poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [slot] }),
    client.readContract({ address: poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [liqSlot] }),
  ]);
  const v = BigInt(raw);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  const tickRaw = Number((v >> 160n) & ((1n << 24n) - 1n));
  const tick = tickRaw >= (1 << 23) ? tickRaw - (1 << 24) : tickRaw;
  const lpFee = Number((v >> 208n) & ((1n << 24n) - 1n));
  return { sqrtPriceX96, tick, lpFee, liquidity: BigInt(rawLiq) };
}

// Price of token1 in token0 units: price = (sqrtPriceX96 / 2^96)^2 * 10^(dec0-dec1).
// FIXED 2026-11-08 (Part 51): the old code computed the sqrt-price ratio as
// Number((sqrtP * 1000000n) / Q96) / 1e6 — BigInt division floors values
// < 1e-6 to 0, so any pool whose sqrt price < 1e-6 priced at EXACTLY 0.
// That is what killed FOBO's position price (sqrtP 7019216284471902465404,
// ratio ~8.86e-8 -> 0) and with it the +100%/-50% sell triggers, which
// read 0 USDG/token in every cycle. Floating-point ratio handles the full
// range (doubles go to ~1e-308; ~1e-16 relative precision is plenty here).
function priceFromSqrt(sqrtPriceX96, dec0, dec1) {
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  return ratio * ratio * 10 ** (dec0 - dec1);
}

// Bytecode for a set of dangerous selectors (same list as v1, per design §5).
const DANGEROUS_SELECTORS = {
  "0x40c10f19": "mint",
  "0x8456cb59": "pause",
  "0xf2fde38b": "transferOwnership",
  "0x8a8c523c": "blacklist",
  "0x7c9d8dd1": "setMaxTxAmount",
  "0xdfcb2d40": "setTax",
  "0x1f3f5b3a": "setFee",
};
function dangerousSelectorsIn(bytecode) {
  if (!bytecode) return [];
  const lower = bytecode.toLowerCase();
  return Object.entries(DANGEROUS_SELECTORS)
    .filter(([sel]) => lower.includes(sel.slice(2)))
    .map(([sel, name]) => `${name}(${sel})`);
}

// Sourcify verification check (0 points if the call fails — never a hard fail).
async function sourcifyMatch(chainId, address) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${address}`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return { verified: false, match: null };
    const j = await res.json();
    return { verified: true, match: j.match || j.status || "match" };
  } catch {
    return { verified: false, match: null };
  }
}

module.exports = {
  INITIALIZE_TOPIC0,
  POOL_MANAGER_ABI,
  ERC20_ABI,
  QUOTER_ABI,
  loadConfig,
  enabledChains,
  makeClient,
  rawGetLogs,
  decodeInitialize,
  scanNewPools,
  readToken,
  readPoolState,
  priceFromSqrt,
  dangerousSelectorsIn,
  sourcifyMatch,
};
