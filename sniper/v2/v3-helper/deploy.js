// Deploy V3SwapHelper on Robinhood Chain (4663) from the Privy agent wallet.
// Mirrors the RMUSE deploy precedent: creation tx via Privy CLI rpc
// (no `to`), machine-identity restore first, poll for receipt.
// Writes deploy-result.json with the deployed address + tx details.
const fs = require("fs");
const { execSync } = require("child_process");
const {
  createPublicClient, http, parseAbi, getContractAddress,
} = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");

const DIR = "/home/hatch/workspace/tokens/sniper/v2/v3-helper";
const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const RPC = "https://rpc.mainnet.chain.robinhood.com";

const client = createPublicClient({ transport: http(RPC) });

function privyRpc(jsonObj) {
  execSync("bash /home/hatch/workspace/privy/restore-privy-machine-identity.sh", { stdio: "pipe" });
  const body = JSON.stringify(jsonObj);
  const out = execSync(
    `cd /home/hatch/workspace/privy/agent-cli && ./node_modules/.bin/privy-agent-wallet rpc --json '${body.replace(/'/g, "'\\''")}'`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

async function waitReceipt(hash, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await client.getTransactionReceipt({ hash });
      if (r) return r;
    } catch (e) {
      if (!String(e.message).includes("TransactionReceiptNotFoundError") && !String(e.name).includes("TransactionReceiptNotFoundError")) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("waitReceipt timed out for " + hash);
}

async function main() {
  const artifact = JSON.parse(fs.readFileSync(`${DIR}/out/V3SwapHelper.sol/V3SwapHelper.json`, "utf8"));
  let bytecode = artifact.bytecode.object;
  if (!bytecode.startsWith("0x")) bytecode = "0x" + bytecode;
  console.log("creation bytecode bytes:", (bytecode.length - 2) / 2);

  // Fresh nonce — predict the CREATE address from it.
  const nonce = await client.getTransactionCount({ address: AGENT });
  const predicted = getContractAddress({ from: AGENT, nonce: BigInt(nonce) });
  console.log("agent nonce:", nonce, "| predicted helper address:", predicted);

  const body = {
    method: "eth_sendTransaction",
    caip2: "eip155:4663",
    params: { transaction: { from: AGENT, value: "0x0", data: bytecode } },
  };
  const res = privyRpc(body);
  const hash = res?.data?.hash;
  if (!hash) throw new Error("Privy CLI did not return a tx hash: " + JSON.stringify(res).slice(0, 400));
  console.log("deploy tx hash:", hash);

  const receipt = await waitReceipt(hash);
  console.log("receipt status:", receipt.status, "| block:", receipt.blockNumber, "| gas used:", receipt.gasUsed.toString());
  console.log("deployed contract:", receipt.contractAddress);
  if (receipt.contractAddress.toLowerCase() !== predicted.toLowerCase()) {
    console.log("NOTE: deployed address differs from prediction (nonce moved between read and send?)");
  }

  // Verify onchain: code exists + owner() == agent.
  const code = await client.getCode({ address: receipt.contractAddress });
  console.log("deployed code bytes:", (code.length - 2) / 2);
  const owner = await client.readContract({
    address: receipt.contractAddress,
    abi: parseAbi(["function owner() view returns (address)"]),
    functionName: "owner",
  });
  console.log("owner():", owner, owner.toLowerCase() === AGENT.toLowerCase() ? "MATCH (agent)" : "MISMATCH");

  const result = {
    contract: "V3SwapHelper",
    chainId: 4663,
    deployTx: hash,
    block: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    status: receipt.status,
    address: receipt.contractAddress,
    predicted,
    nonce: Number(nonce),
    owner,
    creationBytes: (bytecode.length - 2) / 2,
    deployedBytes: (code.length - 2) / 2,
  };
  fs.writeFileSync(`${DIR}/deploy-result.json`, JSON.stringify(result, null, 2));
  console.log("wrote deploy-result.json");
}

main().catch((e) => { console.error("DEPLOY FAILED:", e.message); process.exit(1); });
