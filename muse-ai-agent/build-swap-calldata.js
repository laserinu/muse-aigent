// Build calldata for the first live $MUSE swap: 0.05 USDC -> MUSE via
// Universal Router V4_SWAP on Arc. Bypasses the V4Quoter (which reverts on
// our hook). Amounts computed from the verified repositioned pool state.
// Run: node build-swap-calldata.js
const { encodeFunctionData, encodeAbiParameters, parseAbi, keccak256, toHex } = require('/home/hatch/workspace/privy/agent-cli/node_modules/viem');

const AGENT = '0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4';
const USDC = '0x3600000000000000000000000000000000000000';
const MUSE = '0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198';
const HOOK = '0xD8791D64Be0ecca433BBe30c2A4Ff36D7Eca0044';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const UNIVERSAL_ROUTER = '0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1';

const AMOUNT_IN = 50000n; // 0.05 USDC (6 dec)
// Expected from exact V4 math (sqrtP 354319114228591420592203432321452013, L 21130171658904):
//   gross out 986,590,472,305,758,645 base units (986,590,472.31 MUSE)
//   hook fee 3% = 29,597,714,169,172,759 ; net to trader 956,992,758,136,585,886
// amountOutMinimum = net minus 2% slippage
const AMOUNT_OUT_MIN = 937852902973854168n;
const NET_EXPECTED = 956992758136585886n;
const FEE_EXPECTED = 29597714169172759n;
const GROSS_EXPECTED = 986590472305758645n;

const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
const routerAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
]);

// ---- Tx A: approve USDC -> Permit2 (exact 50000) ----
const approveData = encodeFunctionData({
  abi: erc20Abi, functionName: 'approve', args: [PERMIT2, AMOUNT_IN],
});

// ---- Tx B: permit2.approve(USDC, UniversalRouter, 50000, +1y) ----
const nowSec = Math.floor(Date.now() / 1000);
const expiration = nowSec + 365 * 24 * 3600;
const permit2Data = encodeFunctionData({
  abi: permit2Abi, functionName: 'approve',
  args: [USDC, UNIVERSAL_ROUTER, AMOUNT_IN, expiration],
});

// ---- Tx C: Universal Router execute V4_SWAP ----
// PoolKey as a nested TUPLE inside ExactInputSingleParams (NOT as bytes —
// encoding it as bytes misaligns the struct and the swap reverts bare).
const poolKeyComponents = [
  { type: 'address', name: 'currency0' },
  { type: 'address', name: 'currency1' },
  { type: 'uint24', name: 'fee' },
  { type: 'int24', name: 'tickSpacing' },
  { type: 'address', name: 'hooks' },
];
const swapParams = encodeAbiParameters(
  [{ type: 'tuple', name: 'params', components: [
    { type: 'tuple', name: 'poolKey', components: poolKeyComponents },
    { type: 'bool', name: 'zeroForOne' },
    { type: 'uint128', name: 'amountIn' },
    { type: 'uint128', name: 'amountOutMinimum' },
    { type: 'uint256', name: 'minHopPriceX36' },
    { type: 'bytes', name: 'hookData' },
  ]}],
  [{ poolKey: { currency0: USDC, currency1: MUSE, fee: 3000, tickSpacing: 60, hooks: HOOK }, zeroForOne: true, amountIn: AMOUNT_IN, amountOutMinimum: AMOUNT_OUT_MIN, minHopPriceX36: 0n, hookData: '0x' }]
);
// SETTLE_ALL: (Currency, uint256)
const settleParams = encodeAbiParameters(
  [{ type: 'address' }, { type: 'uint256' }],
  [USDC, AMOUNT_IN]
);
// TAKE_ALL: (Currency, uint256)
const takeParams = encodeAbiParameters(
  [{ type: 'address' }, { type: 'uint256' }],
  [MUSE, AMOUNT_OUT_MIN]
);
// V4_SWAP input: abi.encode(bytes actions, bytes[] params)
const actions = '0x060c0f'; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
const v4SwapInput = encodeAbiParameters(
  [{ type: 'bytes' }, { type: 'bytes[]' }],
  [actions, [swapParams, settleParams, takeParams]]
);
const deadline = nowSec + 1800; // 30 min
const executeData = encodeFunctionData({
  abi: routerAbi, functionName: 'execute',
  args: ['0x10', [v4SwapInput], BigInt(deadline)],
});

console.log(JSON.stringify({
  amountIn: AMOUNT_IN.toString(),
  grossExpected: GROSS_EXPECTED.toString(),
  feeExpected: FEE_EXPECTED.toString(),
  netExpected: NET_EXPECTED.toString(),
  amountOutMinimum: AMOUNT_OUT_MIN.toString(),
  deadline,
  expiration,
  txA_approveUsdcPermit2: approveData,
  txB_permit2ApproveRouter: permit2Data,
  txC_routerExecute: executeData,
  router: UNIVERSAL_ROUTER,
  permit2: PERMIT2,
}, null, 2));
