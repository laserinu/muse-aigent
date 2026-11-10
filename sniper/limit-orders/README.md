# General 1inch limit-order tool

One command places a 1inch limit order for **any ERC-20 token on any supported chain** —
built from the old limit-order-protocol 4.2.2 source (the older app.1inch.io advanced limit
order version, the user's favorite venue for limit orders).

## Usage

```bash
node place-order.js --chain 8453 --maker WETH --taker 0x8888... --amount full --price 1e-7 --years 3
node place-order.js --chain 137 --maker WPOL --taker <CA> --amount 1000000000000000000 --price 1e-7 --years 3 --dry-run
```

- `--chain`: 8453 Base, 137 Polygon, 4663 Robinhood, 5042 Arc (1 Ethereum is blocked by policy)
- `--maker`: token address, or `WETH` / `WPOL` for the chain's wrapped native
- `--taker`: any ERC-20 contract address
- `--amount`: raw units, or `full` (live balance)
- `--price`: maker per taker, decimal (`1e-7`)
- `--years` / `--expiry`: order expiry (default 3 years)
- `--wrap <wei>`: wrap native -> wrapped native first
- `--dry-run`: build + verify the hash, sign/send nothing

## What it does

1. Verifies the 1inch router onchain (code + EIP-712 domain `1inch Aggregation Router` v6)
2. Wraps native -> WETH if asked; reads the maker balance; exact-amount approval if needed
3. Signs the order via the Privy agent wallet (EIP-712)
4. Triple-checks the order hash: viem == official 1inch SDK == onchain `LOP.hashOrder`
5. Tries the 1inch orderbook API (401 without a key — needs a KYC'd Business account)
6. Publishes onchain via `OrderRegistrator.registerOrder` where one exists (emits
   `OrderRegistered`, the permissionless discovery path)

## Chain table (verified onchain 2026-11-10)

| Chain | Router | Registrator | Publish |
|---|---|---|---|
| Base 8453 | Aggregation Router v6 `0x1111...2a65` | `0x2339...1CCE` | onchain ✓ |
| Polygon 137 | Aggregation Router v6 `0x1111...2a65` | `0x2339...1CCE` | onchain ✓ |
| Robinhood 4663 | `0x5a70...389C7` | none | API-only |
| Arc 5042 | `0xe08c...6bda` | none | API-only |

## Live orders placed with it

- Base NAMI: full WETH balance -> 1,426.69 NAMI @ 1e-7, expiry 2027-02-08 (hash `0x78896f8a…`,
  register tx `0xa67cedb3…`) and expiry 2029-11-10 (hash `0xa7363e21…`, register tx `0x2945ba3c…`).
- Robinhood NAMI: 0.00015 WETH -> 1,500 NAMI @ 1e-7, 3y (hash `0x5aa44e33…`) — signed +
  verified, not published (no Robinhood registrator), not yet funded (wrap at publish time).

Signed orders are saved in `orders/` (JSON, ready to submit via the API when a key exists).

## Traps this tool already handles

- The EIP-712 domain is `1inch Aggregation Router` v6 — NOT the protocol repo's
  `1inch Limit Order Protocol` v4.
- The deployed `Address` type wraps `uint256` in call ABIs — address-typed calls give wrong
  selectors and empty reverts.
- The old public orderbook (`limit-orders.1inch.io`) is dead; `api.1inch.dev` needs a key.

Full report: `~/workspace/research_notes/general-1inch-limit-order-tool-20261110/report.md`
(tools-and-sites Part 87).
