# Split Bill Calculator

[![CI](https://github.com/tranquockiet09295/Split-Bill-Calculator/actions/workflows/ci.yml/badge.svg)](https://github.com/tranquockiet09295/Split-Bill-Calculator/actions/workflows/ci.yml)

A Stellar testnet dApp that splits a bill across N addresses, sends each their share, and (optionally) records the bill on-chain so payers can settle in a custom stablecoin via an inter-contract token transfer. Built for the **Stellar Journey to Mastery** Builder Track, Levels 1–4.

**Live demo:** https://splitbillcalculator-two.vercel.app/
**Video demo:** https://drive.google.com/file/d/10b_CTXsSGoXmHRnT5q1M57h-5OSBql7r/view?usp=drive_link
- **L1 (White Belt)** — Freighter / multi-wallet connect, balance display, send equal-split XLM to N addresses in one transaction.
- **L2 (Yellow Belt)** — `BillSplit` Soroban contract deployed on testnet; frontend creates bills and listens for `settled` events; ≥3 error categories surfaced; tx-status pipeline (preparing → signing → submitting → confirming).
- **L3 (Orange Belt)** — Loading skeletons, in-memory TTL cache for reads, "who paid / who owes" view per bill, contract + frontend test suites (12 + 16 = 28 tests).
- **L4 (Green Belt)** — Custom **SEP-41 stablecoin** (`StableToken`) deployed alongside; `BillSplit::settle` does an **inter-contract `token::Client::transfer(payer → creator, share)`** so settlement actually moves funds atomically. GitHub Actions CI runs `cargo test --workspace` and `npm test && npm run build` on every push/PR. Layout is mobile-responsive at 360px+.

## Project layout

```
.
├── contracts/
│   ├── bill-split/        # Soroban contract — bills + inter-contract settle
│   └── stable-token/      # Custom SEP-41 stablecoin (settlement currency)
├── frontend/              # Vite + React 19 + TypeScript dApp
├── .github/workflows/     # CI (cargo test --workspace + vitest + vite build)
├── Cargo.toml             # Rust workspace
└── README.md
```

## How the contracts work

### `bill-split` (`contracts/bill-split/src/lib.rs`)

- **Constructor** `__constructor(token: Address)` — pins the settlement token address into instance storage.
- `create_bill(creator, payers, share, memo) → u32` — `creator.require_auth()`, validates inputs (`share > 0`, ≤ 20 payers, ≤ 80-char memo), stores the bill, indexes it under both creator and each payer, returns the new id, emits `("created", creator)`.
- `settle(id, payer)` — `payer.require_auth()`. Looks up the bill; verifies `payer` is in its payer list and not already settled; **invokes `token::Client::new(&env, &token).transfer(&payer, &creator, &share)` (the L4 inter-contract call)**; marks the (id, payer) pair settled; emits `("settled", payer)`.
- View functions: `token`, `get_bill`, `is_settled`, `bill_count`, `bills_by_creator`, `bills_by_payer`.

Validation panics: `share must be positive`, `payers required`, `too many payers`, `memo too long`, `address is not a payer on this bill`, `already settled`, `bill not found`, `contract not initialized`.

### `stable-token` (`contracts/stable-token/src/lib.rs`)

Minimal SEP-41 token implementing `TokenInterface` (so any `token::Client` can call it). Custom additions: `__constructor(admin, decimals, name, symbol)`, admin-only `mint`, `set_admin`, `total_supply`. The standard SEP-41 surface (`balance`, `transfer`, `transfer_from`, `approve`, `allowance`, `burn`, `burn_from`, `decimals`, `name`, `symbol`) is fully present.

The `BillSplit` contract treats this as an opaque `Address` — any SEP-41-compatible token works (including the native XLM SAC), so this stablecoin is a sample reference implementation rather than a hard dependency.

## How the frontend works

Five files under `frontend/src/`:

- `config.ts` — RPC / Horizon URLs, network passphrase, `CONTRACT_ID`, `STABLE_TOKEN_ID`, `STABLE_SYMBOL` (all env-overridable via `VITE_*`).
- `lib.ts` — pure helpers (`xlmToStroops`, `stroopsToXlm`, `computeShares`, `isLikelyStellarAddress`, `decodeSimError`, `ContractError`). Dependency-free so Vitest can import without dragging in the wallet kit.
- `wallet.ts` — wraps `@creit.tech/stellar-wallets-kit` (multi-wallet picker; Freighter, Albedo, xBull, Lobstr…).
- `contract.ts` — Soroban call orchestration: native-XLM split (`sendXlmSplit`), contract writes (`createBill`, `settleBill`), reads (`getBill`, `isSettled`, `getBillCount`, `getBillsByPayer`, `getBillsByCreator`, `getStableBalance`), and the `settled` event feed. TTL-cached reads with explicit invalidation after writes (the settle path also flushes the stable-balance cache because the inter-contract transfer changes it).
- `App.tsx` — UI: wallet card with XLM + stablecoin balances, split form, on-chain bill list with paid/owes pills per payer, and a 5 s-polled live event feed. Mobile breakpoints at 600px and 480px stack the header, collapse the panel rows, and unwrap bill metadata.

### Error handling

Every error throws a `ContractError` with one of five `category` values, all routed to the same red status banner with a user-actionable message:

1. **`validation`** — bad amount, missing payers, malformed G addresses, contract not configured (caught client-side, no wallet roundtrip).
2. **`rejected`** — user dismissed the wallet signature prompt.
3. **`rpc`** — sender account not funded, RPC unreachable, confirmation timeout.
4. **`simulation`** — Soroban contract panic mapped to a friendly message (`decodeSimError`) — covers all bill-split panics plus `InsufficientBalance` from the stable-token sub-invocation.
5. **`submission`** — Horizon / Soroban submit error, with the Stellar `result_codes` extras inlined when present.

## Setup

### Prerequisites

- Rust + the [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup) (`stellar` binary).
- Node.js 22+ and npm.
- A funded Stellar testnet account on Freighter (or any [supported wallet](https://github.com/Creit-Tech/Stellar-Wallets-Kit)). Use [friendbot](https://laboratory.stellar.org/#account-creator?network=test) to fund.

### Build & test the contracts

```bash
# from repo root
cargo test --workspace            # runs all 12 contract unit tests
stellar contract build            # builds both contracts to wasm32v1-none/release/*.wasm
```

Contract tests:

- `contracts/bill-split/src/test.rs` — 7 tests: happy path with inter-contract token transfer, settled state isolation, all panic paths, double-settle rejection, `token()` view.
- `contracts/stable-token/src/test.rs` — 5 tests: metadata & admin setup, mint, transfer, burn, and `InsufficientBalance` rejection.

### Deploy to testnet

```bash
# one-time identity setup (skip if you already have one)
stellar keys generate me --network testnet --fund

# 1. Deploy the stablecoin first — its address is needed for the bill-split constructor.
stellar contract deploy \
  --wasm target/wasm32v1-none/release/stable_token.wasm \
  --source me \
  --network testnet \
  -- \
  --admin $(stellar keys address me) \
  --decimal 7 \
  --name "BillCoin" \
  --symbol "BILL"
# → prints the StableToken contract address. Save it as $STABLE_ID.

# 2. Mint some BillCoin to your wallet for testing.
stellar contract invoke \
  --id $STABLE_ID \
  --source me \
  --network testnet \
  -- \
  mint --to $(stellar keys address me) --amount 10000000000   # 1000 BILL

# 3. Deploy the bill-split contract pointing at the stablecoin.
stellar contract deploy \
  --wasm target/wasm32v1-none/release/bill_split.wasm \
  --source me \
  --network testnet \
  -- \
  --token $STABLE_ID
# → prints the BillSplit contract address. Save it as $BILL_ID.
```

### Run the frontend

```bash
cd frontend
npm install
cp .env.example .env
# edit .env — set:
#   VITE_CONTRACT_ID=$BILL_ID
#   VITE_STABLE_TOKEN_ID=$STABLE_ID
#   VITE_STABLE_SYMBOL=BILL
npm run dev          # http://localhost:5173
```

### Run the frontend tests

```bash
cd frontend
npm test             # vitest run — 16 tests
```

## Submission checklist

| Level | Requirement | Where |
| --- | --- | --- |
| L1 | Wallet connect / disconnect | `wallet.ts` + `App.tsx` (StellarWalletsKit) |
| L1 | Fetch + display balance | `contract.ts` `fetchXlmBalance` (and `getStableBalance` for L4) |
| L1 | Send testnet XLM | `contract.ts` `sendXlmSplit` (N payment ops in one tx) |
| L1 | Tx feedback (success / fail / hash) | `App.tsx` status banner + Stellar Expert link |
| L2 | 3+ error categories | `ContractError` (`validation`, `rejected`, `rpc`, `simulation`, `submission`) |
| L2 | Contract deployed on testnet | bill-split + stable-token (paste addresses below) |
| L2 | Contract called from frontend | `createBill`, `settleBill` in `contract.ts` |
| L2 | Tx status visible | `TxStatus` pipeline in status banner |
| L3 | Mini-dApp fully functional | App.tsx — split + record + settle + history + events |
| L3 | ≥3 tests passing | **28 total** (12 contract + 16 frontend) |
| L3 | Loading states / progress indicators | `.skeleton` shimmer + `.status` phase pills |
| L3 | Basic caching | TTL `Map` cache in `contract.ts`, invalidated after writes |
| **L4** | **Inter-contract call working** | `BillSplit::settle` → `token::Client::transfer` |
| **L4** | **Custom token deployed** | `stable-token` SEP-41 contract |
| **L4** | **CI/CD running** | `.github/workflows/ci.yml` (cargo test + vitest + vite build) |
| **L4** | **Mobile responsive** | breakpoints at 600px / 480px in `index.css` |

## Deployed addresses

| Item | Address / Hash |
| --- | --- |
| `bill-split` contract (testnet) | [`CC3FCIOUDBWLK3X65WJFQQTHLPEO7MEAG4DNLYFU4FNQPCIZKC4ANMUU`](https://stellar.expert/explorer/testnet/contract/CC3FCIOUDBWLK3X65WJFQQTHLPEO7MEAG4DNLYFU4FNQPCIZKC4ANMUU) |
| `stable-token` contract (testnet) | [`CD56P27YTBVMHMTMFP56SPYS4DTCYRFEMO3AB64NCLDOR6433CQPZ4EI`](https://stellar.expert/explorer/testnet/contract/CD56P27YTBVMHMTMFP56SPYS4DTCYRFEMO3AB64NCLDOR6433CQPZ4EI) |
| Sample split + `create_bill` tx hash | `91b246f763…` (see screenshot 2 below) |
| Live demo | https://splitbillcalculator-two.vercel.app/ |

## Screenshots

### 1. Wallet connected — XLM + BILL balances + split form (L1, L2, L4)

Wallet card shows **XLM** and **BILL** balances side by side; the split form is filled with a 1 XLM bill split between two payers, with "Also record on-chain" enabled.

![Wallet connected and split form](docs/screenshots/01-wallet-and-form.png)

### 2. Successful split tx + on-chain bill recorded (L1, L2, L3)

Green status banner confirming the split was sent and recorded as bill #1, with a clickable tx hash. The "Your bills" panel below shows bill #1 with both payers in `owes` state.

![Successful tx and bill list](docs/screenshots/02-tx-success-and-bill.png)

### 3. Mobile responsive view (L4)

The split form rendered on a mobile viewport — header, panels, and payer rows stack cleanly.

<img src="docs/screenshots/03-mobile.jpg" alt="Mobile responsive view" width="360" />

### 4. CI/CD pipeline (L4)

CI status is shown by the green badge at the top of this README — it links directly to the latest GitHub Actions run at <https://github.com/tranquockiet09295/Split-Bill-Calculator/actions>.

## License

MIT
