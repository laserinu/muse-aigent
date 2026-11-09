// Verify current $MUSE pool state on Arc before repositioning.
// Read-only: extsload for pool slot0, PositionManager position info, ERC-20 balances.
const { createPublicClient, http, keccak256, encodeAbiParameters, parseAbi } = require('/home/hatch/workspace/privy/agent-cli/node_modules/viem');

const RPC = 'https://rpc.blockdaemon.mainnet.arc.io';
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const POSITION_MANAGER = '0x6049c9a0e26405C0985f9E3685C87d0aE917f82B';
const MUSE = '0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198';
const USDC = '0x3600000000000000000000000000000000000000';
const AGENT = '0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4';
const POOL_ID = '0x5a14e63c9943a180d24b31f45964bc11e24639e9f055f88f33a3ac58b6b27ff1';
const TOKEN_ID = 322143n;

const pmAbi = parseAbi([
  'function extsload(bytes32 slot) external view returns (bytes32)',
  'function getPositionLiquidity(uint256 tokenId) external view returns (uint128)',
  'function getPoolAndPositionInfo(uint256 tokenId) external view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 positionInfo)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
]);
const erc20Abi = parseAbi([
  'function balanceOf(address) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
]);

async function main() {
  const client = createPublicClient({ transport: http(RPC) });
  const block = await client.getBlockNumber();
  console.log('block:', block.toString());

  // Pool slot0: keccak256(abi.encode(poolId, uint256(6)))
  const slot = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }],
    [POOL_ID, 6n],
  ));
  const slot0raw = await client.readContract({
    address: POOL_MANAGER, abi: pmAbi, functionName: 'extsload', args: [slot],
  });
  const v = BigInt(slot0raw);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  const protocolFee = Number((v >> 184n) & 0xffffffn);
  const lpFee = Number((v >> 208n) & 0xffffffn);
  console.log('sqrtPriceX96:', sqrtPriceX96.toString());
  console.log('tick:', tick);
  console.log('protocolFee:', protocolFee, 'lpFee:', lpFee);
  // price: MUSE per USDC = 1.0001^tick * (10^9 / 10^6)? tick is for currency1/currency0 price.
  // currency0 = USDC (0x3600...), currency1 = MUSE (0xd124...). sqrtPriceX96 = sqrt(price1/0) * 2^96.
  // price (MUSE per USDC) = (sqrtPriceX96 / 2^96)^2 * 10^(dec0-dec1) = (sqrt/2^96)^2 * 10^(6-9)
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const musePerUsdc = ratio * ratio * 1e-3;
  console.log('MUSE per USDC:', musePerUsdc, '=> price per MUSE (USDC):', 1 / musePerUsdc);

  // Position info
  const liq = await client.readContract({
    address: POSITION_MANAGER, abi: pmAbi, functionName: 'getPositionLiquidity', args: [TOKEN_ID],
  });
  console.log('position 322143 liquidity:', liq.toString());
  const owner = await client.readContract({
    address: POSITION_MANAGER, abi: pmAbi, functionName: 'ownerOf', args: [TOKEN_ID],
  });
  console.log('position 322143 owner:', owner);
  const [poolKey, posInfo] = await client.readContract({
    address: POSITION_MANAGER, abi: pmAbi, functionName: 'getPoolAndPositionInfo', args: [TOKEN_ID],
  });
  console.log('poolKey:', JSON.stringify(poolKey, (k, val) => typeof val === 'bigint' ? val.toString() : val));
  const info = BigInt(posInfo);
  let tickLower = Number((info >> 8n) & 0xffffffn);
  if (tickLower >= 0x800000) tickLower -= 0x1000000;
  let tickUpper = Number((info >> 32n) & 0xffffffn);
  if (tickUpper >= 0x800000) tickUpper -= 0x1000000;
  console.log('position tickLower:', tickLower, 'tickUpper:', tickUpper, 'hasSubscriber:', Number(info & 0xffn));

  // Balances
  const museBal = await client.readContract({ address: MUSE, abi: erc20Abi, functionName: 'balanceOf', args: [AGENT] });
  const usdcBal = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [AGENT] });
  console.log('agent MUSE balance (base units):', museBal.toString());
  console.log('agent USDC balance (base units, 6 dec):', usdcBal.toString(), '=', (Number(usdcBal) / 1e6).toFixed(6), 'USDC');
  // PoolManager token balances (reserves held by PoolManager for this pool are not directly separable, but check total)
  const pmMuse = await client.readContract({ address: MUSE, abi: erc20Abi, functionName: 'balanceOf', args: [POOL_MANAGER] });
  const pmUsdc = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [POOL_MANAGER] });
  console.log('PoolManager MUSE balance:', pmMuse.toString());
  console.log('PoolManager USDC balance:', pmUsdc.toString());
  // Factory MUSE balance
  const FACTORY = '0xD5941aedf552ab2B9Ff1bB20C1C4bd7813B561e0';
  const facMuse = await client.readContract({ address: MUSE, abi: erc20Abi, functionName: 'balanceOf', args: [FACTORY] });
  console.log('Factory MUSE balance:', facMuse.toString());
  // Gas price
  const gasPrice = await client.getGasPrice();
  console.log('gasPrice (wei):', gasPrice.toString(), '=', (Number(gasPrice) / 1e9).toFixed(3), 'gwei');
  const feeHist = await client.getFeeHistory({ blockCount: 5, rewardPercentiles: [50] });
  console.log('feeHistory baseFeePerGas:', feeHist.baseFeePerGas.map((x) => (Number(x) / 1e9).toFixed(3) + ' gwei').join(', '));
}

main().catch((e) => { console.error('ERROR:', e.message || e); process.exit(1); });
