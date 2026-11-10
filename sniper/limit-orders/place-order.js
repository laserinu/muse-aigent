// place-order.js — GENERAL 1inch limit-order placer (old 4.2.2 protocol, via Aggregation Router v6).
// Works for ANY ERC-20 taker on ANY supported chain. Not NAMI-specific.
// Built from the proven place-1inch.js (Base, 2 orders live 2026-11-10) — same patterns:
//   viem from the Privy agent-cli node_modules; SDK typed-data builder from the deep path;
//   domain built manually as '1inch Aggregation Router' v6 (verified against the deployed
//   router's onchain eip712Domain() per chain); onchain calls encode Address as uint256.
// Chain config verified onchain 2026-11-10:
//   Base 8453 + Polygon 137: LOP = Aggregation Router v6 0x1111...2a65, domain v6,
//     OrderRegistrator 0x2339f78e2Ec15C47Cf042F2460C532C0D7ff1CCE (same CREATE3 address,
//     byte-identical code on both — its LOP is private immutable, so no getter exists).
//   Robinhood 4663: LOP 0x5a705de8982235a7fa45bb83dcacf03a211389c7, domain v6. NO registrator.
//   Arc 5042: LOP 0xe08cab0828a67291ec4af1fb3e7f867e206a6bda, domain v6. NO registrator.
//   Ethereum 1: supported by 1inch but BLOCKED here by default (agent mainnet policy).
// No-registrator chains: orders can be built+signed+verified but only published via the
// 1inch API (needs a key) — the tool saves them ready to submit.
//
// Usage:
//   node place-order.js --chain 8453 --maker WETH --taker 0x8888...888 --amount full --price 1e-7 --years 3
//   node place-order.js --chain 4663 --maker WETH --taker <CA> --amount 150000000000000 --price 1e-7 --years 3
//   node place-order.js --chain 137 --maker WPOL --taker <CA> --amount 1000000000000000000 --price 1e-7 --years 3 --dry-run
//   --wrap <native-wei> wraps native ETH -> wrapped native first (maker must be the wrapped native).
//   --expiry <unix> overrides --years. --out <path> sets the result file. --allow-mainnet unlocks chain 1.
'use strict';
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { recoverTypedDataAddress, hashTypedData, encodeFunctionData, decodeFunctionResult } = require('/home/hatch/workspace/privy/agent-cli/node_modules/viem');
const { getOrderHash: sdkGetOrderHash, buildOrderTypedData: sdkBuildOrderTypedData } = require('/home/hatch/workspace/tokens/nami-limit-orders/node_modules/@1inch/limit-order-sdk/dist/cjs/limit-order/eip712/order-typed-data-builder.js');

const AGENT = '0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4';
const ZERO = '0x0000000000000000000000000000000000000000';
const REGISTRATOR = '0x2339f78e2Ec15C47Cf042F2460C532C0D7ff1CCE';
const RESTORE = '/home/hatch/workspace/privy/restore-privy-machine-identity.sh';
const PRIVY_CLI = '/home/hatch/workspace/privy/agent-cli/node_modules/.bin/privy-agent-wallet';
const MIN_SELL = 1000000000000n;

const CHAINS = {
  8453: { name: 'Base', rpc: 'https://base-rpc.publicnode.com', receiptRpc: 'https://mainnet.base.org', lop: '0x111111125421ca6dc452d289314280a0f8842a65', reg: REGISTRATOR, weth: '0x4200000000000000000000000000000000000006', wethSymbol: 'WETH', explorer: 'https://basescan.org' },
  137: { name: 'Polygon', rpc: 'https://polygon-bor-rpc.publicnode.com', receiptRpc: 'https://polygon-bor-rpc.publicnode.com', lop: '0x111111125421ca6dc452d289314280a0f8842a65', reg: REGISTRATOR, weth: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', wethSymbol: 'WPOL', explorer: 'https://polygonscan.com' },
  4663: { name: 'Robinhood', rpc: 'https://rpc.mainnet.chain.robinhood.com', receiptRpc: 'https://rpc.mainnet.chain.robinhood.com', lop: '0x5a705de8982235a7fa45bb83dcacf03a211389c7', reg: null, weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', wethSymbol: 'WETH', explorer: 'https://robin.etherscan.io' },
  5042: { name: 'Arc', rpc: 'https://rpc.blockdaemon.mainnet.arc.io', receiptRpc: 'https://rpc.blockdaemon.mainnet.arc.io', lop: '0xe08cab0828a67291ec4af1fb3e7f867e206a6bda', reg: null, weth: null, wethSymbol: null, explorer: 'https://arc.etherscan.io' },
  1: { name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', receiptRpc: 'https://ethereum-rpc.publicnode.com', lop: '0x111111125421ca6dc452d289314280a0f8842a65', reg: REGISTRATOR, weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', wethSymbol: 'WETH', explorer: 'https://etherscan.io' },
};

const ORDER_ABI = [{ name: 'hashOrder', type: 'function', stateMutability: 'view', inputs: [{ name: 'order', type: 'tuple', components: [
  { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'uint256' }, { name: 'receiver', type: 'uint256' },
  { name: 'makerAsset', type: 'uint256' }, { name: 'takerAsset', type: 'uint256' }, { name: 'makingAmount', type: 'uint256' },
  { name: 'takingAmount', type: 'uint256' }, { name: 'makerTraits', type: 'uint256' }] }], outputs: [{ name: '', type: 'bytes32' }] }];
const REGISTER_ABI = [{ name: 'registerOrder', type: 'function', stateMutability: 'nonpayable', inputs: [
  { name: 'order', type: 'tuple', components: [
    { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'uint256' }, { name: 'receiver', type: 'uint256' },
    { name: 'makerAsset', type: 'uint256' }, { name: 'takerAsset', type: 'uint256' }, { name: 'makingAmount', type: 'uint256' },
    { name: 'takingAmount', type: 'uint256' }, { name: 'makerTraits', type: 'uint256' }] },
  { name: 'extension', type: 'bytes' }, { name: 'signature', type: 'bytes' }], outputs: [] }];
const DOMAIN_ABI = [{ name: 'eip712Domain', type: 'function', stateMutability: 'view', inputs: [], outputs: [
  { name: 'fields', type: 'bytes1' }, { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' }, { name: 'extensions', type: 'uint256[]' }] }];

function args() {
  const out = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      out[k] = (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) ? process.argv[++i] : true;
    }
  }
  return out;
}
function parsePrice(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)[eE]([+-]?\d+)$/) || String(s).match(/^(\d+(?:\.\d+)?)$/);
  if (!m) throw new Error('bad --price: ' + s);
  const [int, frac = ''] = m[1].split('.');
  const exp = m[2] ? parseInt(m[2], 10) : 0;
  let num = BigInt(int + frac), den = 10n ** BigInt(frac.length);
  if (exp >= 0) num *= 10n ** BigInt(exp); else den *= 10n ** BigInt(-exp);
  return { num, den };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function privyRpc(jsonObj) {
  execSync(RESTORE, { stdio: 'pipe' });
  const body = JSON.stringify(jsonObj);
  const out = execSync(`cd /home/hatch/workspace/privy/agent-cli && ./node_modules/.bin/privy-agent-wallet rpc --json '${body.replace(/'/g, "'\\''")}'`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(out);
}
async function rpcCall(rpc, method, params) {
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ' failed: ' + JSON.stringify(j.error).slice(0, 200));
  return j.result;
}
const pad32 = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
async function waitReceipt(rpc, hash, label) {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await rpcCall(rpc, 'eth_getTransactionReceipt', [hash]);
      if (r) {
        console.log(`  ${label} receipt: status=${parseInt(r.status, 16)} block=${parseInt(r.blockNumber, 16)} gasUsed=${parseInt(r.gasUsed, 16)}`);
        if (parseInt(r.status, 16) !== 1) throw new Error(`${label} tx reverted: ${hash}`);
        return r;
      }
    } catch (e) { /* retry ANY RPC error */ }
    await sleep(2000);
  }
  throw new Error(`${label} receipt timeout: ${hash}`);
}
async function tokenCall(rpc, token, data) {
  return rpcCall(rpc, 'eth_call', [{ to: token, data }, 'latest']);
}
const balOf = (rpc, token, who) => tokenCall(rpc, token, '0x70a08231' + '000000000000000000000000' + who.slice(2).toLowerCase()).then(BigInt);
const allowanceOf = (rpc, token, owner, spender) => tokenCall(rpc, token, '0xdd62ed3e' + '000000000000000000000000' + owner.slice(2).toLowerCase() + '000000000000000000000000' + spender.slice(2).toLowerCase()).then(BigInt);
const decimalsOf = (rpc, token) => tokenCall(rpc, token, '0x313ce567').then((h) => Number(BigInt(h)));
const symbolOf = (rpc, token) => tokenCall(rpc, token, '0x95d89b41').then((h) => {
  try {
    const d = decodeFunctionResult({ abi: [{ name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] }], functionName: 'symbol', data: h });
    return Array.isArray(d) ? d[0] : d; // viem returns the bare string here, not an array
  } catch { return '?'; }
});

(async () => {
  const a = args();
  const chainId = parseInt(a.chain, 10);
  const cfg = CHAINS[chainId];
  if (!cfg) throw new Error('unsupported --chain ' + a.chain + ' (supported: ' + Object.keys(CHAINS).join(', ') + ')');
  if (chainId === 1 && !a['allow-mainnet']) throw new Error('Ethereum mainnet is blocked by agent policy. Pass --allow-mainnet to override.');
  const dryRun = !!a['dry-run'];
  const caip2 = `eip155:${chainId}`;
  const makerRaw = String(a.maker || '').toUpperCase();
  const makerIsWrapped = makerRaw === 'WETH' || makerRaw === 'WPOL';
  const maker = makerIsWrapped ? cfg.weth : String(a.maker);
  if (!maker) throw new Error('Arc has no wrapped native: pass an explicit --maker token address');
  const taker = String(a.taker);
  if (!taker || taker.length !== 42) throw new Error('pass a valid --taker token address');
  const { num: priceNum, den: priceDen } = parsePrice(a.price);
  const expiry = a.expiry ? parseInt(a.expiry, 10) : Math.floor(Date.now() / 1000) + Math.round(parseFloat(a.years || '3') * 365.25 * 86400);

  // 1. Verify the LOP onchain: code + EIP-712 domain must be '1inch Aggregation Router' v6 for this chain.
  const lopCode = await rpcCall(cfg.rpc, 'eth_getCode', [cfg.lop, 'latest']);
  if (!lopCode || lopCode === '0x') throw new Error('no LOP code at ' + cfg.lop + ' on ' + cfg.name);
  const domRaw = await tokenCall(cfg.rpc, cfg.lop, encodeFunctionData({ abi: DOMAIN_ABI, functionName: 'eip712Domain' }));
  const dom = decodeFunctionResult({ abi: DOMAIN_ABI, functionName: 'eip712Domain', data: domRaw });
  if (dom[1] !== '1inch Aggregation Router' || dom[2] !== '6' || Number(dom[3]) !== chainId || dom[4].toLowerCase() !== cfg.lop.toLowerCase())
    throw new Error(`domain mismatch on ${cfg.name}: ${dom[1]} v${dom[2]} chain ${dom[3]} ${dom[4]}`);
  console.log(`chain: ${cfg.name} (${chainId}) | LOP ${cfg.lop} | domain OK (${dom[1]} v${dom[2]}) | registrator: ${cfg.reg || 'NONE (API-only)'}`);
  const domain = { name: dom[1], version: dom[2], chainId, verifyingContract: cfg.lop };

  // 2. Optional wrap: native -> wrapped native.
  if (a.wrap) {
    if (dryRun) console.log(`  [dry-run] would wrap ${a.wrap} wei native -> ${cfg.wethSymbol}`);
    else {
      console.log(`  wrapping ${a.wrap} wei native -> ${cfg.wethSymbol}...`);
      const res = privyRpc({ method: 'eth_sendTransaction', caip2, params: { transaction: { from: AGENT, to: maker, value: '0x' + BigInt(a.wrap).toString(16), data: '0xd0e30db0' } } });
      const hash = res?.data?.hash;
      if (!hash) throw new Error('wrap tx no hash: ' + JSON.stringify(res).slice(0, 300));
      console.log('  wrap tx:', hash);
      await waitReceipt(cfg.receiptRpc, hash, 'wrap');
    }
  }

  // 3. Maker balance + decimals; resolve makingAmount; compute takingAmount.
  const [makerBal, makerDec, makerSym, takerDec, takerSym] = await Promise.all([
    balOf(cfg.rpc, maker, AGENT), decimalsOf(cfg.rpc, maker), symbolOf(cfg.rpc, maker),
    decimalsOf(cfg.rpc, taker), symbolOf(cfg.rpc, taker),
  ]);
  let makingAmount = String(a.amount).toLowerCase() === 'full' ? makerBal : BigInt(a.amount);
  if (makingAmount > makerBal) console.log(`  WARNING: makingAmount ${makingAmount} exceeds live balance ${makerBal} (order will be unfillable until funded)`);
  if (makingAmount < MIN_SELL && !dryRun) throw new Error(`makingAmount ${makingAmount} below dust floor ${MIN_SELL}`);
  const takingAmount = makingAmount * (10n ** BigInt(takerDec)) * priceDen / ((10n ** BigInt(makerDec)) * priceNum);
  console.log(`maker: ${makingAmount} ${makerSym} (balance ${makerBal}) -> taker: ${takingAmount} ${takerSym} @ ${a.price} ${makerSym}/${takerSym} | expiry ${expiry} (${new Date(expiry * 1000).toISOString().slice(0, 10)})`);

  // 4. Allowance: exact-amount approve if needed (skip in dry-run).
  if (!dryRun) {
    const allow = await allowanceOf(cfg.rpc, maker, AGENT, cfg.lop);
    console.log('  LOP allowance:', allow.toString());
    if (allow < makingAmount) {
      console.log(`  approving exactly ${makingAmount} ${makerSym} to LOP...`);
      const data = '0x095ea7b3' + pad32(cfg.lop) + pad32('0x' + makingAmount.toString(16));
      const res = privyRpc({ method: 'eth_sendTransaction', caip2, params: { transaction: { from: AGENT, to: maker, value: '0x0', data } } });
      const hash = res?.data?.hash;
      if (!hash) throw new Error('approve tx no hash: ' + JSON.stringify(res).slice(0, 300));
      console.log('  approve tx:', hash);
      await waitReceipt(cfg.receiptRpc, hash, 'approve');
    }
  } else console.log('  [dry-run] allowance step skipped');

  // 5. Build the order.
  const salt = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
  const makerTraits = BigInt(expiry) << 80n; // expiration in bits 80..119, no flags
  const order = { salt, maker: AGENT, receiver: ZERO, makerAsset: maker, takerAsset: taker, makingAmount, takingAmount, makerTraits };
  const types = {
    EIP712Domain: [
      { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
    ],
    Order: [
      { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'receiver', type: 'address' },
      { name: 'makerAsset', type: 'address' }, { name: 'takerAsset', type: 'address' },
      { name: 'makingAmount', type: 'uint256' }, { name: 'takingAmount', type: 'uint256' }, { name: 'makerTraits', type: 'uint256' },
    ],
  };
  const message = {
    salt: salt.toString(), maker: AGENT, receiver: ZERO, makerAsset: maker, takerAsset: taker,
    makingAmount: makingAmount.toString(), takingAmount: takingAmount.toString(), makerTraits: makerTraits.toString(),
  };

  // 6. Sign via Privy (skip in dry-run) + verify recovery.
  let signature = null;
  if (!dryRun) {
    console.log('Signing via Privy...');
    const sigRes = privyRpc({ method: 'eth_signTypedData_v4', caip2, params: { typed_data: { types, domain, primary_type: 'Order', message } } });
    signature = sigRes?.data?.signature;
    if (!signature || !signature.startsWith('0x') || signature.length !== 132) throw new Error('signing failed: ' + JSON.stringify(sigRes).slice(0, 300));
    console.log('  signature:', signature.slice(0, 66) + '...');
    const recovered = await recoverTypedDataAddress({ domain, types, primaryType: 'Order', message: order, signature });
    console.log('  recovered signer:', recovered);
    if (recovered.toLowerCase() !== AGENT.toLowerCase()) throw new Error('signature does NOT recover to agent wallet — refusing to submit');
  } else console.log('  [dry-run] signing skipped');

  // 7. Three-way hash check: viem == 1inch SDK == onchain LOP.hashOrder.
  const viemHash = hashTypedData({ domain, types, primaryType: 'Order', message: order });
  console.log('orderHash (viem):', viemHash);
  const sdkTypedData = sdkBuildOrderTypedData(chainId, cfg.lop, domain.name, domain.version, message);
  const sdkHash = sdkGetOrderHash(sdkTypedData);
  console.log('orderHash (1inch SDK):', sdkHash);
  if (sdkHash.toLowerCase() !== viemHash.toLowerCase()) throw new Error('order hash mismatch between viem and the 1inch SDK — refusing to submit');
  const orderTuple = [salt, BigInt(AGENT), 0n, BigInt(maker), BigInt(taker), makingAmount, takingAmount, makerTraits];
  const hashCalldata = encodeFunctionData({ abi: ORDER_ABI, functionName: 'hashOrder', args: [orderTuple] });
  const hashRaw = await tokenCall(cfg.rpc, cfg.lop, hashCalldata);
  const onchainHash = decodeFunctionResult({ abi: ORDER_ABI, functionName: 'hashOrder', data: hashRaw });
  console.log('orderHash (LOP.hashOrder onchain):', onchainHash);
  if (onchainHash.toLowerCase() !== viemHash.toLowerCase()) throw new Error('order hash mismatch between viem and LOP.hashOrder — refusing to submit');

  // 8. API attempt (401 without a key is expected).
  let apiStatus = 0, apiOut = {};
  try {
    const resp = await fetch(`https://api.1inch.dev/orderbook/v4.0/${chainId}/order`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...message, signature: signature || '' }),
    });
    apiStatus = resp.status;
    apiOut = await resp.json().catch(() => ({}));
    console.log('API submit:', apiStatus, JSON.stringify(apiOut).slice(0, 200));
  } catch (e) { console.log('API request failed:', e.message.slice(0, 80)); }

  // 9. Publish onchain via OrderRegistrator (if deployed on this chain).
  let registerTx = null, registerBlock = null, registerGasUsed = null, orderRegisteredEvent = false;
  if (!dryRun && signature && cfg.reg) {
    console.log('Publishing onchain via OrderRegistrator.registerOrder...');
    const regCalldata = encodeFunctionData({ abi: REGISTER_ABI, functionName: 'registerOrder', args: [orderTuple, '0x', signature] });
    const sim = await rpcCall(cfg.rpc, 'eth_call', [{ from: AGENT, to: cfg.reg, data: regCalldata }, 'latest']);
    console.log('  registerOrder simulation OK (returned', sim.slice(0, 10) + ')');
    const regRes = privyRpc({ method: 'eth_sendTransaction', caip2, params: { transaction: { from: AGENT, to: cfg.reg, value: '0x0', data: regCalldata } } });
    registerTx = regRes?.data?.hash;
    if (!registerTx) throw new Error('register tx no hash: ' + JSON.stringify(regRes).slice(0, 300));
    console.log('  register tx:', registerTx);
    const receipt = await waitReceipt(cfg.receiptRpc, registerTx, 'registerOrder');
    registerBlock = parseInt(receipt.blockNumber, 16); registerGasUsed = parseInt(receipt.gasUsed, 16);
    orderRegisteredEvent = (receipt.logs || []).some((l) => l.address && l.address.toLowerCase() === cfg.reg.toLowerCase());
    console.log('  OrderRegistered event log present:', orderRegisteredEvent);
    if (!orderRegisteredEvent) throw new Error('registerOrder mined but no OrderRegistered event found in receipt');
  } else if (!cfg.reg) console.log(`  No registrator on ${cfg.name} — order NOT published onchain; submit via the API when a key is available.`);
  else if (dryRun) console.log('  [dry-run] publication skipped');

  const result = {
    chain: chainId, chainName: cfg.name, submittedAt: new Date().toISOString(), dryRun,
    maker, makerSymbol: makerSym, taker, takerSymbol: takerSym,
    makingAmount: makingAmount.toString(), takingAmount: takingAmount.toString(), price: String(a.price),
    expiry, salt: salt.toString(), makerTraits: makerTraits.toString(),
    orderHash: viemHash, signature, apiStatus, apiResponse: apiOut,
    registerTx, registerBlock, registerGasUsed, orderRegisteredEvent,
  };
  const outPath = a.out || `/home/hatch/workspace/tokens/limit-orders/orders/${chainId}-${takerSym.toLowerCase()}-${viemHash.slice(2, 10)}.json`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log((dryRun ? 'DRY-RUN OK' : (cfg.reg ? 'ORDER SIGNED + VERIFIED + PUBLISHED ONCHAIN' : 'ORDER SIGNED + VERIFIED (unpublished — no registrator)')) + ', hash: ' + viemHash);
  console.log('result:', outPath);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
