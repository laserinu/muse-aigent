// unwrap-weth.js — unwrap ALL agent WETH -> ETH on Robinhood (user-approved dust sweep 2026-11-08).
// After the v1 sell-all, the agent holds ~0.0000589 WETH; ETH is the gas token, so unwrap it.
const { createPublicClient, http, parseAbi, encodeFunctionData } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const trade = require("./trade.js");
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const client = createPublicClient({ transport: http(RPC) });
const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function withdraw(uint256 wad)",
]);
(async () => {
  const bal = await client.readContract({ address: WETH, abi, functionName: "balanceOf", args: [AGENT] });
  console.log("WETH balance:", bal.toString());
  if (bal === 0n) {
    console.log("nothing to unwrap");
    return;
  }
  const data = encodeFunctionData({ abi, functionName: "withdraw", args: [bal] });
  const hash = await trade.sendTx({ to: WETH, value: "0x0", data });
  const rc = await trade.waitReceipt(hash);
  console.log("unwrap tx:", hash, "status:", rc.status, "gasUsed:", rc.gasUsed.toString());
  const eth = await client.getBalance({ address: AGENT });
  const wethAfter = await client.readContract({ address: WETH, abi, functionName: "balanceOf", args: [AGENT] });
  console.log("ETH after:", eth.toString(), "WETH after:", wethAfter.toString());
})().catch((e) => {
  console.error("UNWRAP ERROR:", e);
  process.exit(1);
});
