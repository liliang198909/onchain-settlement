# OnchainSettlement

Escrowed limit-order settlement for ERC-20 pairs on EVM chains. Makers post a
price and deposit the offered token into escrow; takers pull liquidity by
filling an order id, fully or partially. The contract enforces the maker's price
ratio, routes the protocol fee and protects funds with `ReentrancyGuard` and
`SafeERC20`.

This repository is the on-chain half of a two-part trading stack. Its sibling
[`matching-engine`](https://github.com/liliang198909/matching-engine) is an
off-chain Go matching engine that decides *who* trades with whom; this contract
guarantees *how* the assets move once a fill is executed.

- Off-chain (`matching-engine`, Go): price-time priority, in-memory order book, high throughput.
- On-chain (`onchain-settlement`, Solidity): custody, atomic asset exchange, fee accounting, final settlement.

---

## Order lifecycle

```
   MAKER                         CONTRACT                        TAKER
     │                              │                              │
     │ approve(sellToken)           │                              │
     │─────────────────────────────►│                              │
     │ createOrder(                 │                              │
     │   sellToken, buyToken,       │                              │
     │   sellAmount, buyAmount,     │  sellToken held in escrow    │
     │   expiry)                    │                              │
     │─────────────────────────────►│──── escrow ────┐            │
     │                              │◄───────────────┘            │
     │                              │                              │
     │                              │◄──── fill(orderId, amount) ──│
     │                              │                              │
     │◄── buyAmount net of fee ─────│──► sellAmount from escrow ───│
     │                              │                              │
     │                              │──► fee accrued for recipient │
     │                              │                              │
     │ cancelOrder(orderId)         │                              │
     │─────────────────────────────►│                              │
     │◄── unfilled escrow refunded ─│                              │
```

Every order can be filled in as many slices as a taker wants. The final slice
always sweeps the exact remainder, so a fully filled order never leaves dust.

---

## Quick start

```bash
npm install
npx hardhat compile
npx hardhat test
npx hardhat run scripts/deploy.js
```

The deploy script deploys two demo ERC-20s, the settlement contract, and seeds a
partially filled order so you can inspect the resulting state immediately.

---

## Contract API

### Maker

| Function | Description |
| --- | --- |
| `createOrder(sellToken, buyToken, sellAmount, buyAmount, expiry)` | Escrows `sellAmount` of `sellToken` and publishes a limit order. `expiry = 0` means the order never expires. |
| `cancelOrder(orderId)` | Maker-only. Refunds the unfilled escrow. A fully filled order cannot be cancelled. |

### Taker

| Function | Description |
| --- | --- |
| `fill(orderId, sellFill)` | Buys `sellFill` of the maker's token and pays the pro-rata amount of the buy token, fee included. |
| `remaining(orderId)` | Unfilled `(sellRemaining, buyRemaining)`. |
| `pricePerSellToken(orderId)` | The order's price, scaled by `1e18`. |

### Admin

| Function | Description |
| --- | --- |
| `setFeeBps(newFeeBps)` | Owner-only. Capped at `MAX_FEE_BPS` (100 bps = 1%). |
| `setFeeRecipient(newRecipient)` | Owner-only. |
| `withdrawFees(token, to)` | Callable by the owner or the fee recipient. |

### Events

`OrderCreated`, `OrderFilled`, `OrderCancelled`, `FeeBpsUpdated`,
`FeeRecipientUpdated`, `FeesWithdrawn`.

---

## Design notes

**Escrow, not signature relay.** Makers deposit the offered token up front. That
makes settlement a pure bookkeeping operation — the taker's transaction either
gets both legs or reverts — at the cost of locking maker capital until the order
is filled or cancelled. The alternative (EIP-712 signed orders with allowance
relay) removes the lock-up but requires a trusted relayer and shifts execution
risk onto the maker.

**Pull settlement, no on-chain book.** There is no sorted price-time queue in
this contract. Maintaining one on-chain is gas-prohibitive: every insertion
shifts storage. Instead, orders are addressed by id and takers choose which
order to hit. Matching is the off-chain engine's job; this contract only needs to
enforce the maker's stated ratio, which is what makes it cheap enough to run.

**Pro-rata partial fills with a sweeping final slice.** A partial fill pays
`floor(sellFill * buyAmount / sellAmount)`. Rounding down favours the taker by
less than one wei per fill, which is bounded and harmless. The last slice breaks
the pattern deliberately: when `sellFill == remainingSell` the taker is charged
exactly `buyAmount - filledBuy`, so rounding residue can never accumulate into
unfillable dust.

**Zero-priced fills are rejected.** With a floor-rounded ratio, a small enough
`sellFill` computes a `buyFill` of zero — the taker would receive tokens for
free. `FillTooSmall` blocks that path.

**Accrued fees, not eager transfers.** Fees stay in the contract in
`accruedFees[token]` and are withdrawn in one batch, instead of pushing a
separate transfer to the fee recipient on every fill. Fewer token transfers per
fill and a predictable gas profile.

**Self-fills are blocked.** `msg.sender == order.maker` reverts, so a maker
cannot wash-trade against their own order to distort on-chain volume.

**Re-entrancy.** `fill`, `createOrder`, `cancelOrder` and `withdrawFees` are all
`nonReentrant`. The test suite proves this with a malicious ERC-20 that re-enters
`fill` from inside `transferFrom`.

---

## Test coverage

`npx hardhat test` runs 30 tests:

| Area | Coverage |
| --- | --- |
| `createOrder` | escrow accounting, stored fields, maker order index, identical tokens, zero amounts, past expiry, missing approval |
| `fill` | full fill at the maker's price, pro-rata partial fills, no dust after a slice sequence, too-small fills, zero/oversized fills, unknown order, self-fill, expiry, missing approval, re-entrancy from the buy token |
| `cancelOrder` | refund of the unfilled escrow, fills blocked afterwards, maker-only, double cancel, fully filled order, unknown order |
| Fees | accrual across fills, zero-fee configuration, withdrawal, authorization, empty withdrawal, cap enforcement, owner-only config, zero recipient |
| Views | `pricePerSellToken`, `getMakerOrderIds` |

---

## Trust model and security

- **Custody:** the contract holds maker escrow and accrued fees. Losing the
  owner key only risks the fee configuration, not user escrow — there is no
  admin path that can move escrowed tokens.
- **Pricing:** the maker's ratio is fixed at creation and cannot be changed
  afterwards. There is no oracle, so no oracle-manipulation surface; a maker
  posting a mispriced order can be arbitraged, which is the maker's risk.
- **Rounding:** bounded to under one wei per fill, and swept exactly on the
  final fill.
- **Not audited.** This is a portfolio project, not production infrastructure.

---

## Future work

- EIP-712 signed orders with allowance-based relay, to remove the escrow lock-up.
- A Chainlink price feed guard that rejects fills more than *N%* away from a
  reference mid price, protecting makers from fat-finger ratios.
- Partial-fill minimums per order, to bound the rounding loss on pathological ratios.
- Maker order pagination and on-chain filtering helpers for front-ends.

---

## License

MIT.
