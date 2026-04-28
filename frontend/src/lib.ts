// Pure, dependency-free helpers. Tests can import these without dragging in
// the wallet kit / Stellar SDK (both have CJS interop quirks under Vitest).

import { STROOPS_PER_XLM } from './config';

export type ContractErrorCategory =
  | 'validation'
  | 'rejected'
  | 'submission'
  | 'rpc'
  | 'simulation';

export class ContractError extends Error {
  category: ContractErrorCategory;

  constructor(message: string, category: ContractErrorCategory) {
    super(message);
    this.name = 'ContractError';
    this.category = category;
  }
}

/** Convert a user-entered XLM string ("12.5") to stroops as a bigint. */
export function xlmToStroops(xlm: string): bigint {
  const trimmed = xlm.trim();
  if (!/^-?\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new ContractError(
      'Amount must be a number with up to 7 decimals.',
      'validation',
    );
  }
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = body.split('.');
  const padded = (frac + '0000000').slice(0, 7);
  const magnitude = BigInt(whole) * STROOPS_PER_XLM + BigInt(padded || '0');
  const stroops = negative ? -magnitude : magnitude;
  if (stroops <= 0n) {
    throw new ContractError('Amount must be greater than 0.', 'validation');
  }
  return stroops;
}

export function stroopsToXlm(stroops: bigint | number | string): string {
  const value = typeof stroops === 'bigint' ? stroops : BigInt(stroops);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / STROOPS_PER_XLM;
  const frac = (magnitude % STROOPS_PER_XLM)
    .toString()
    .padStart(7, '0')
    .replace(/0+$/, '');
  const formatted = frac ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${formatted}` : formatted;
}

/** Split `total` stroops into `n` shares. The last payer absorbs the remainder
 *  so the sum exactly equals the total (avoids the "1 stroop missing" rounding
 *  bug). */
export function computeShares(total: bigint, n: number): bigint[] {
  if (n <= 0) {
    throw new ContractError('At least one payer is required.', 'validation');
  }
  if (total <= 0n) {
    throw new ContractError('Total must be greater than 0.', 'validation');
  }
  const base = total / BigInt(n);
  const shares = Array.from({ length: n }, () => base);
  const remainder = total - base * BigInt(n);
  shares[n - 1] += remainder;
  return shares;
}

/** Lightweight Stellar G... address sanity check — strkey checksum still
 *  validated by the SDK at tx-build time, but this catches typos in the form
 *  before we hit the RPC. */
export function isLikelyStellarAddress(s: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(s.trim());
}

/** Translate a raw Soroban simulation error into something a user can act on. */
export function decodeSimError(raw: string): string {
  if (raw.includes('share must be positive'))
    return 'Per-payer share must be greater than 0.';
  if (raw.includes('payers required'))
    return 'At least one payer address is required.';
  if (raw.includes('too many payers'))
    return 'Too many payers (max 20 per bill).';
  if (raw.includes('memo too long'))
    return 'Memo must be 80 characters or fewer.';
  if (raw.includes('not a payer'))
    return 'This address is not a payer on that bill.';
  if (raw.includes('already settled'))
    return 'This payer has already settled.';
  if (raw.includes('bill not found')) return 'Bill not found.';
  if (raw.toLowerCase().includes('insufficient'))
    return 'Insufficient balance for this transaction.';
  if (raw.includes('Account_does_not_exist'))
    return 'Sender account does not exist on testnet (fund it first).';
  return `Simulation failed: ${raw.slice(0, 240)}`;
}
