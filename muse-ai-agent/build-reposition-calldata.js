// Build all calldata for the $MUSE repositioning (burn full-range NFT 322143,
// mint concentrated [304080, 308520]). No transactions sent here — outputs JSON
// files for the Privy CLI rpc call.
const { encodeFunctionData, parseAbi, encodeAbiParameters, keccak256, toHex } = require('/home/hatch/workspace/privy/agent-cli/node_modules/viem');

const AGENT = '0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4';
const MUSE = '0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198';
const USDC = '0x3600000000000000000000000000000000000000';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const POSITION_MANAGER = '0x6049c9a0e26405C0985f9E3685C87d0aE917f82B';
const HOOK = '0xD8791D64Be0ecca433BBe30c2A4Ff36D7Eca0044';
const TOKEN_ID = 322143n;
const TICK_LOWER = 304080;
const TICK_UPPER = 308520;
const LIQUIDITY = 21130171658904n; // from LiquidityAmounts (forge script)
const AMOUNT0_MAX = 500000n; // USDC base units (0.5)
const AMOUNT1_MAX = 10n ** 19n; // MUSE base units (10B)
const MUSE_AMOUNT = 10n ** 19n;
const USDC_AMOUNT = 500000n;
const MAX_EXP = (1n << 48n) - 1n;

const poolKey = {
  currency0: USDC,
  currency1: MUSE,
  fee: 3000,
  tickSpacing: 60,
  hooks: HOOK,
};

const pmAbi = parseAbi([
  'function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable',
]);
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
]);
const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
]);

// Deadline: now + 2h (plenty for sequential sends; checked against block.timestamp)
const deadline = BigInt(Math.floor(Date.now() / 1000) + 7200);
console.log('deadline:', deadline.toString());

// --- 1. Burn old position: actions [BURN_POSITION=0x03, TAKE_PAIR=0x11]
const burnParams = encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
  [TOKEN_ID, 0n, 0n, '0x'],
);
const takePairParams = encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
  [USDC, MUSE, AGENT],
);
const burnUnlock = encodeAbiParameters(
  [{ type: 'bytes' }, { type: 'bytes[]' }],
  ['0x0311', [burnParams, takePairParams]],
);
const burnData = encodeFunctionData({
  abi: pmAbi, functionName: 'modifyLiquidities', args: [burnUnlock, deadline],
});
console.log('burn calldata:', burnData);

// --- 2. Mint new position: actions [MINT_POSITION=0x02, SETTLE_PAIR=0x0d]
const poolKeyType = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
};
const mintParams = encodeAbiParameters(
  [poolKeyType, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }],
  [poolKey, TICK_LOWER, TICK_UPPER, LIQUIDITY, AMOUNT0_MAX, AMOUNT1_MAX, AGENT, '0x'],
);
const settlePairParams = encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }],
  [USDC, MUSE],
);
const mintUnlock = encodeAbiParameters(
  [{ type: 'bytes' }, { type: 'bytes[]' }],
  ['0x020d', [mintParams, settlePairParams]],
);
const mintData = encodeFunctionData({
  abi: pmAbi, functionName: 'modifyLiquidities', args: [mintUnlock, deadline],
});
console.log('mint calldata:', mintData);

// --- 3. Approvals
const approveMusePermit2 = encodeFunctionData({
  abi: erc20Abi, functionName: 'approve', args: [PERMIT2, MUSE_AMOUNT],
});
const approveUsdcPermit2 = encodeFunctionData({
  abi: erc20Abi, functionName: 'approve', args: [PERMIT2, USDC_AMOUNT],
});
const permit2Muse = encodeFunctionData({
  abi: permit2Abi, functionName: 'approve', args: [MUSE, POSITION_MANAGER, MUSE_AMOUNT, MAX_EXP],
});
const permit2Usdc = encodeFunctionData({
  abi: permit2Abi, functionName: 'approve', args: [USDC, POSITION_MANAGER, USDC_AMOUNT, MAX_EXP],
});
console.log('approve MUSE->Permit2:', approveMusePermit2);
console.log('approve USDC->Permit2:', approveUsdcPermit2);
console.log('permit2 MUSE->PositionManager:', permit2Muse);
console.log('permit2 USDC->PositionManager:', permit2Usdc);

// Write Privy CLI rpc JSON files
const fs = require('fs');
const out = '/home/hatch/workspace/tokens/muse-ai-agent/reposition';
fs.mkdirSync(out, { recursive: true });
function rpcJson(to, data) {
  return JSON.stringify({
    method: 'eth_sendTransaction',
    caip2: 'eip155:5042',
    params: { transaction: { from: AGENT, to, value: '0x0', data } },
  });
}
fs.writeFileSync(`${out}/01-approve-muse-permit2.json`, rpcJson(MUSE, approveMusePermit2));
fs.writeFileSync(`${out}/02-approve-usdc-permit2.json`, rpcJson(USDC, approveUsdcPermit2));
fs.writeFileSync(`${out}/03-permit2-muse.json`, rpcJson(PERMIT2, permit2Muse));
fs.writeFileSync(`${out}/04-permit2-usdc.json`, rpcJson(PERMIT2, permit2Usdc));
fs.writeFileSync(`${out}/05-burn-position.json`, rpcJson(POSITION_MANAGER, burnData));
fs.writeFileSync(`${out}/06-mint-position.json`, rpcJson(POSITION_MANAGER, mintData));
console.log('wrote 6 rpc json files to', out);
console.log('deadline (unix):', deadline.toString());
