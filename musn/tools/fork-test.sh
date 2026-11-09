#!/usr/bin/env bash
# MUSN fork test runner — one chain at a time.
# Usage: ./fork-test.sh <base|polygon|arc|robinhood> [tokenSalt] [collectorSalt]
#   Salts are bytes32 hex (default 0x00..0 = mechanics test).
#   Pass the ground salts for the vanity run.
# Starts an anvil fork (gas price 1 gwei so the agent's fork balance covers
# the deploys), runs ForkDeployTest.s.sol, then stops anvil.
# The fork test MOVES FUNDS ON THE LOCAL FORK ONLY — no mainnet tx.
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"

CHAIN="${1:?usage: fork-test.sh <base|polygon|arc|robinhood> [tokenSalt] [collectorSalt]}"
TOKEN_SALT="${2:-0x0000000000000000000000000000000000000000000000000000000000000000}"
COLLECTOR_SALT="${3:-0x0000000000000000000000000000000000000000000000000000000000000000}"
AGENT=0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4
PORT=8545

case "$CHAIN" in
  base)      RPC="https://base-rpc.publicnode.com" ;;
  polygon)   RPC="https://polygon-bor-rpc.publicnode.com" ;;
  arc)       RPC="https://rpc.blockdaemon.mainnet.arc.io" ;;
  robinhood) RPC="${ROBINHOOD_RPC:-https://rpc.mainnet.chain.robinhood.com}" ;;
  *) echo "unknown chain: $CHAIN"; exit 1 ;;
esac

echo "=== MUSN fork test: $CHAIN (rpc $RPC) ==="
echo "tokenSalt:     $TOKEN_SALT"
echo "collectorSalt: $COLLECTOR_SALT"

# Stop any anvil already on the port.
pkill -f "anvil.*--port $PORT" 2>/dev/null; sleep 1

anvil --fork-url "$RPC" --gas-price 1000000000 --port "$PORT" \
  --block-time 1 > "/tmp/musn-anvil-$CHAIN.log" 2>&1 &
ANVIL_PID=$!
echo "anvil pid $ANVIL_PID, waiting for it to come up..."
for i in $(seq 1 30); do
  if curl -s -X POST "http://localhost:$PORT" -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | grep -q result; then
    break
  fi
  sleep 1
done

# Impersonate the agent on anvil so it can sign the broadcast txs
# (forge script --unlocked alone does not always trigger impersonation).
cast rpc --rpc-url "http://localhost:$PORT" anvil_impersonateAccount "$AGENT" >/dev/null 2>&1
echo "impersonated $AGENT on anvil"

MUSN_CHAIN="$CHAIN" MUSN_TOKEN_SALT="$TOKEN_SALT" MUSN_COLLECTOR_SALT="$COLLECTOR_SALT" \
  forge script script/ForkDeployTest.s.sol \
  --fork-url "http://localhost:$PORT" \
  --sender "$AGENT" --unlocked --broadcast --start-fresh \
  2>&1 | tee "/tmp/musn-fork-$CHAIN.log"
STATUS=${PIPESTATUS[0]}

kill "$ANVIL_PID" 2>/dev/null
echo "=== fork test $CHAIN exit: $STATUS (log /tmp/musn-fork-$CHAIN.log) ==="
exit "$STATUS"
