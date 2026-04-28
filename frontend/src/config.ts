import { Networks } from '@stellar/stellar-sdk';

/** Deployed bill-split contract address (testnet). Empty string disables
 *  contract-mode features in the UI. */
export const CONTRACT_ID =
  (import.meta.env.VITE_CONTRACT_ID as string | undefined) ?? '';

/** L4 settlement-token (SEP-41) address. The bill-split contract calls
 *  `transfer` on this token from inside `settle()` (inter-contract call), so
 *  payers must hold a balance here. Optional: if unset, the UI just hides
 *  the stablecoin balance and "settle" still works as long as bill-split's
 *  configured token matches. */
export const STABLE_TOKEN_ID =
  (import.meta.env.VITE_STABLE_TOKEN_ID as string | undefined) ?? '';

/** Display label for the settlement token (purely cosmetic). */
export const STABLE_SYMBOL =
  (import.meta.env.VITE_STABLE_SYMBOL as string | undefined) ?? 'BILL';

export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const HORIZON_URL = 'https://horizon-testnet.stellar.org';

// XLM = 7 decimals; on-chain amounts are stroops (i128).
// We use the same scale for the stablecoin to keep arithmetic uniform.
export const STROOPS_PER_XLM = 10_000_000n;
