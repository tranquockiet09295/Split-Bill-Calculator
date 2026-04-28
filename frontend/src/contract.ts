import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Memo,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';
import type { xdr } from '@stellar/stellar-sdk';

import {
  CONTRACT_ID,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
  RPC_URL,
  STABLE_TOKEN_ID,
} from './config';
import { ContractError, decodeSimError } from './lib';
import { signXdr } from './wallet';

export {
  ContractError,
  type ContractErrorCategory,
  computeShares,
  decodeSimError,
  isLikelyStellarAddress,
  stroopsToXlm,
  xlmToStroops,
} from './lib';

export const sorobanServer = new rpc.Server(RPC_URL);
export const horizonServer = new Horizon.Server(HORIZON_URL);

const billContract = () => new Contract(CONTRACT_ID);
const stableContract = () => new Contract(STABLE_TOKEN_ID);

// Read-only sims don't commit, so any structurally valid Stellar address works.
const READ_ONLY_SOURCE =
  'GCVNQZPI76QNMDKFC5DVDXHUXFVM3ABHARWJ4DOFFACQ4F2E6KYYH63A';

export type TxStatus = 'preparing' | 'signing' | 'submitting' | 'confirming';

// ──────────────────────────────────────────────────────────────────────────
// Bill record types (mirror the contract structs)
// ──────────────────────────────────────────────────────────────────────────

export type Bill = {
  id: number;
  creator: string;
  payers: string[];
  share: bigint;
  memo: string;
  timestamp: bigint;
};

export type SettledEvent = {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  billId: number;
  payer: string;
  share: bigint;
  txHash?: string;
};

// ──────────────────────────────────────────────────────────────────────────
// Read cache (TTL'd in-memory map). Invalidated after writes.
// ──────────────────────────────────────────────────────────────────────────

type CacheEntry = { value: unknown; expiresAt: number };
const readCache = new Map<string, CacheEntry>();

async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const entry = readCache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.value as T;
  }
  const value = await fn();
  readCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export function invalidateReads(prefix?: string): void {
  if (!prefix) {
    readCache.clear();
    return;
  }
  for (const key of readCache.keys()) {
    if (key.startsWith(prefix)) readCache.delete(key);
  }
}

const BILL_TTL_MS = 10_000;
const EVENTS_TTL_MS = 4_000;

// ──────────────────────────────────────────────────────────────────────────
// Simulation helpers
// ──────────────────────────────────────────────────────────────────────────

async function simulate(
  contract: Contract,
  fnName: string,
  args: xdr.ScVal[],
  source = READ_ONLY_SOURCE,
): Promise<rpc.Api.SimulateTransactionResponse> {
  const dummy = new Account(source, '0');
  const tx = new TransactionBuilder(dummy, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fnName, ...args))
    .setTimeout(0)
    .build();
  return sorobanServer.simulateTransaction(tx);
}

async function readView<T>(
  contract: Contract,
  fnName: string,
  args: xdr.ScVal[] = [],
): Promise<T> {
  const sim = await simulate(contract, fnName, args);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractError(`Read failed: ${sim.error}`, 'simulation');
  }
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new ContractError('Read returned no result.', 'simulation');
  }
  return scValToNative(sim.result.retval) as T;
}

function ensureContractConfigured(): void {
  if (!CONTRACT_ID) {
    throw new ContractError(
      'No bill-split contract configured. Set VITE_CONTRACT_ID in frontend/.env after deploying.',
      'validation',
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// L1 — Native XLM split payments (no contract involvement)
// ──────────────────────────────────────────────────────────────────────────

/** Send N native-XLM payment ops in one transaction. Each `payments[i]` is the
 *  recipient + amount in stroops. Returns the tx hash. */
export async function sendXlmSplit(opts: {
  sender: string;
  payments: { destination: string; amountStroops: bigint }[];
  memo?: string;
  onStatus?: (status: TxStatus) => void;
}): Promise<string> {
  const { sender, payments, memo, onStatus } = opts;
  if (payments.length === 0) {
    throw new ContractError('At least one payment is required.', 'validation');
  }
  if (payments.length > 100) {
    throw new ContractError(
      'Too many payments — Stellar caps a transaction at 100 ops.',
      'validation',
    );
  }

  onStatus?.('preparing');

  // Use Horizon for the source account here (classic payment ops, not Soroban).
  let source: Horizon.AccountResponse;
  try {
    source = await horizonServer.loadAccount(sender);
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response
      ?.status;
    if (status === 404) {
      throw new ContractError(
        'Sender account does not exist on testnet — fund it from friendbot first.',
        'rpc',
      );
    }
    throw new ContractError(
      `Could not load sender account: ${(err as Error).message}`,
      'rpc',
    );
  }

  const builder = new TransactionBuilder(source, {
    fee: String(Number(BASE_FEE) * payments.length),
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  for (const p of payments) {
    builder.addOperation(
      Operation.payment({
        destination: p.destination,
        asset: Asset.native(),
        // Horizon payment amount is XLM string with up to 7 decimals.
        amount: stroopsAsXlmString(p.amountStroops),
      }),
    );
  }

  if (memo && memo.trim()) {
    // Stellar memo_text is capped at 28 bytes; truncate to keep submission valid.
    builder.addMemo(Memo.text(memo.slice(0, 28)));
  }

  const tx = builder.setTimeout(60).build();

  onStatus?.('signing');
  let signedXdr: string;
  try {
    signedXdr = await signXdr(tx.toXDR(), sender);
  } catch (err) {
    throw new ContractError(
      (err as Error)?.message || 'Signing was rejected.',
      'rejected',
    );
  }

  onStatus?.('submitting');
  const signed = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  try {
    const res = await horizonServer.submitTransaction(signed);
    onStatus?.('confirming');
    return res.hash;
  } catch (err: unknown) {
    const data = (err as { response?: { data?: unknown } })?.response?.data;
    const codes =
      (data as { extras?: { result_codes?: unknown } })?.extras?.result_codes;
    const detail = codes ? JSON.stringify(codes) : (err as Error).message;
    throw new ContractError(`Submission rejected: ${detail}`, 'submission');
  }
}

function stroopsAsXlmString(stroops: bigint): string {
  const negative = stroops < 0n;
  const m = negative ? -stroops : stroops;
  const whole = m / 10_000_000n;
  const frac = (m % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${out}` : out;
}

// ──────────────────────────────────────────────────────────────────────────
// L2 — Contract calls (create_bill, settle, view fns)
// ──────────────────────────────────────────────────────────────────────────

/** Run the full Soroban write pipeline for a contract call. */
async function invokeContract(opts: {
  sender: string;
  fnName: string;
  args: xdr.ScVal[];
  onStatus?: (status: TxStatus) => void;
}): Promise<{ hash: string; returnValue: unknown }> {
  ensureContractConfigured();
  const { sender, fnName, args, onStatus } = opts;

  onStatus?.('preparing');

  let sourceAccount: Account;
  try {
    sourceAccount = await sorobanServer.getAccount(sender);
  } catch (err) {
    throw new ContractError(
      `Could not load account: ${(err as Error).message}`,
      'rpc',
    );
  }

  const baseTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(billContract().call(fnName, ...args))
    .setTimeout(60)
    .build();

  const sim = await sorobanServer.simulateTransaction(baseTx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractError(decodeSimError(sim.error), 'simulation');
  }

  const prepared = rpc.assembleTransaction(baseTx, sim).build();

  onStatus?.('signing');
  let signedXdr: string;
  try {
    signedXdr = await signXdr(prepared.toXDR(), sender);
  } catch (err) {
    throw new ContractError(
      (err as Error)?.message || 'Signing was rejected.',
      'rejected',
    );
  }

  onStatus?.('submitting');
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const sendRes = await sorobanServer.sendTransaction(signedTx);
  if (sendRes.status === 'ERROR') {
    throw new ContractError(
      `Submission rejected: ${
        sendRes.errorResult?.result().switch().name ?? 'unknown'
      }`,
      'submission',
    );
  }

  onStatus?.('confirming');
  let getRes = await sorobanServer.getTransaction(sendRes.hash);
  const start = Date.now();
  while (getRes.status === 'NOT_FOUND') {
    if (Date.now() - start > 30_000) {
      throw new ContractError('Timed out waiting for confirmation.', 'rpc');
    }
    await new Promise((r) => setTimeout(r, 1500));
    getRes = await sorobanServer.getTransaction(sendRes.hash);
  }

  if (getRes.status !== 'SUCCESS') {
    throw new ContractError(
      `Transaction failed on-chain: ${getRes.status}`,
      'submission',
    );
  }

  const returnValue =
    getRes.returnValue !== undefined
      ? scValToNative(getRes.returnValue)
      : undefined;

  return { hash: sendRes.hash, returnValue };
}

export async function createBill(opts: {
  sender: string;
  payers: string[];
  shareStroops: bigint;
  memo: string;
  onStatus?: (status: TxStatus) => void;
}): Promise<{ hash: string; billId: number }> {
  const { sender, payers, shareStroops, memo, onStatus } = opts;
  const args: xdr.ScVal[] = [
    Address.fromString(sender).toScVal(),
    nativeToScVal(
      payers.map((p) => Address.fromString(p)),
      { type: 'array' },
    ),
    nativeToScVal(shareStroops, { type: 'i128' }),
    nativeToScVal(memo, { type: 'string' }),
  ];
  const { hash, returnValue } = await invokeContract({
    sender,
    fnName: 'create_bill',
    args,
    onStatus,
  });
  invalidateReads('bills:');
  invalidateReads('count');
  invalidateReads('events:');
  return { hash, billId: Number(returnValue) };
}

export async function settleBill(opts: {
  sender: string;
  billId: number;
  onStatus?: (status: TxStatus) => void;
}): Promise<string> {
  const { sender, billId, onStatus } = opts;
  const args: xdr.ScVal[] = [
    nativeToScVal(billId, { type: 'u32' }),
    Address.fromString(sender).toScVal(),
  ];
  const { hash } = await invokeContract({
    sender,
    fnName: 'settle',
    args,
    onStatus,
  });
  // Settle moves stable-token balance from payer to creator, so invalidate
  // those reads alongside the per-bill settled flag and event feed.
  invalidateReads(`settled:${billId}:`);
  invalidateReads('events:');
  invalidateReads('stable:');
  return hash;
}

/** Read the stable-token balance for `address`. Returns 0n if no token is
 *  configured rather than throwing — callers can render unconditionally. */
export async function getStableBalance(address: string): Promise<bigint> {
  if (!STABLE_TOKEN_ID) return 0n;
  return cached(`stable:${address}`, BILL_TTL_MS, async () => {
    const v = await readView<bigint | number>(stableContract(), 'balance', [
      Address.fromString(address).toScVal(),
    ]);
    return typeof v === 'bigint' ? v : BigInt(v);
  });
}

export async function getBill(id: number): Promise<Bill> {
  ensureContractConfigured();
  return cached(`bills:${id}`, BILL_TTL_MS, async () => {
    const raw = await readView<{
      id: number;
      creator: string;
      payers: string[];
      share: bigint | number;
      memo: string;
      timestamp: bigint | number;
    }>(billContract(), 'get_bill', [nativeToScVal(id, { type: 'u32' })]);
    return {
      id: Number(raw.id),
      creator: String(raw.creator),
      payers: raw.payers.map((p) => String(p)),
      share: typeof raw.share === 'bigint' ? raw.share : BigInt(raw.share),
      memo: String(raw.memo ?? ''),
      timestamp:
        typeof raw.timestamp === 'bigint'
          ? raw.timestamp
          : BigInt(raw.timestamp),
    };
  });
}

export async function isSettled(id: number, payer: string): Promise<boolean> {
  ensureContractConfigured();
  return cached(`settled:${id}:${payer}`, BILL_TTL_MS, async () => {
    return readView<boolean>(billContract(), 'is_settled', [
      nativeToScVal(id, { type: 'u32' }),
      Address.fromString(payer).toScVal(),
    ]);
  });
}

export async function getBillCount(): Promise<number> {
  ensureContractConfigured();
  return cached('count', BILL_TTL_MS, async () => {
    const v = await readView<number | bigint>(billContract(), 'bill_count');
    return Number(v);
  });
}

export async function getBillsByPayer(payer: string): Promise<number[]> {
  ensureContractConfigured();
  return cached(`bills:by-payer:${payer}`, BILL_TTL_MS, async () => {
    const v = await readView<(number | bigint)[]>(
      billContract(),
      'bills_by_payer',
      [Address.fromString(payer).toScVal()],
    );
    return v.map((n) => Number(n));
  });
}

export async function getBillsByCreator(creator: string): Promise<number[]> {
  ensureContractConfigured();
  return cached(`bills:by-creator:${creator}`, BILL_TTL_MS, async () => {
    const v = await readView<(number | bigint)[]>(
      billContract(),
      'bills_by_creator',
      [Address.fromString(creator).toScVal()],
    );
    return v.map((n) => Number(n));
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Settled-event feed
// ──────────────────────────────────────────────────────────────────────────

export async function fetchSettledEvents(opts: {
  ledgersBack?: number;
  limit?: number;
} = {}): Promise<SettledEvent[]> {
  ensureContractConfigured();
  const { ledgersBack = 5_000, limit = 100 } = opts;
  return cached(`events:${ledgersBack}:${limit}`, EVENTS_TTL_MS, () =>
    fetchSettledFresh(ledgersBack, limit),
  );
}

async function fetchSettledFresh(
  ledgersBack: number,
  limit: number,
): Promise<SettledEvent[]> {
  const latest = await sorobanServer.getLatestLedger();
  const startLedger = Math.max(latest.sequence - ledgersBack, 1);

  const result = await sorobanServer.getEvents({
    startLedger,
    filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }],
    limit,
  });

  const out: SettledEvent[] = [];
  for (const ev of result.events) {
    try {
      const topics = ev.topic.map((t) => scValToNative(t));
      const topicName = String(topics[0] ?? '');
      if (topicName !== 'settled') continue; // filter to Settled events
      const payer = String(topics[1] ?? '');
      const value = scValToNative(ev.value) as
        | [number | bigint, bigint | number]
        | undefined;
      if (!value) continue;
      const [billId, share] = value;
      out.push({
        id: ev.id,
        ledger: ev.ledger,
        ledgerClosedAt: ev.ledgerClosedAt,
        billId: Number(billId),
        payer,
        share: typeof share === 'bigint' ? share : BigInt(share),
        txHash: ev.txHash,
      });
    } catch (err) {
      console.warn('[bill-split] failed to decode event', ev, err);
    }
  }
  return out.reverse();
}

// ──────────────────────────────────────────────────────────────────────────
// Wallet balance
// ──────────────────────────────────────────────────────────────────────────

export async function fetchXlmBalance(publicKey: string): Promise<{
  balance: string;
  funded: boolean;
}> {
  try {
    const account = await horizonServer.loadAccount(publicKey);
    const native = account.balances.find((b) => b.asset_type === 'native');
    return { balance: native?.balance ?? '0', funded: true };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response
      ?.status;
    if (status === 404) return { balance: '0', funded: false };
    throw err;
  }
}
