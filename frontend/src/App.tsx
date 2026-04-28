import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CONTRACT_ID, STABLE_SYMBOL, STABLE_TOKEN_ID } from './config';
import {
  ContractError,
  computeShares,
  createBill,
  fetchSettledEvents,
  fetchXlmBalance,
  getBill,
  getBillCount,
  getStableBalance,
  isLikelyStellarAddress,
  isSettled,
  sendXlmSplit,
  settleBill,
  stroopsToXlm,
  xlmToStroops,
  type Bill,
  type SettledEvent,
  type TxStatus,
} from './contract';
import { disconnectWallet, pickWallet } from './wallet';

type Status =
  | { kind: 'idle' }
  | { kind: 'progress'; phase: TxStatus; label: string }
  | { kind: 'success'; hash: string; message: string }
  | { kind: 'error'; message: string };

const PHASE_LABELS: Record<TxStatus, string> = {
  preparing: 'Preparing transaction…',
  signing: 'Awaiting signature in wallet…',
  submitting: 'Submitting to the network…',
  confirming: 'Waiting for confirmation…',
};

function shortAddr(addr: string): string {
  if (!addr) return '';
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function explorerTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

function explorerContractUrl(id: string): string {
  return `https://stellar.expert/explorer/testnet/contract/${id}`;
}

export default function App() {
  // ── wallet ───────────────────────────────────────────────────────────
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [stableBalance, setStableBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  // ── split form ───────────────────────────────────────────────────────
  const [totalXlm, setTotalXlm] = useState('');
  const [memo, setMemo] = useState('');
  const [payers, setPayers] = useState<string[]>(['', '']);
  const [splitStatus, setSplitStatus] = useState<Status>({ kind: 'idle' });
  const [recordOnChain, setRecordOnChain] = useState(true);

  // ── contract panel ───────────────────────────────────────────────────
  const [billCount, setBillCount] = useState<number | null>(null);
  const [bills, setBills] = useState<Bill[]>([]);
  const [billsLoading, setBillsLoading] = useState(false);
  const [settledMap, setSettledMap] = useState<Record<string, boolean>>({});
  const [events, setEvents] = useState<SettledEvent[]>([]);
  const [settleStatus, setSettleStatus] = useState<Status>({ kind: 'idle' });

  // ── connect / disconnect ─────────────────────────────────────────────
  const onConnect = useCallback(async () => {
    try {
      const a = await pickWallet();
      setAddress(a);
    } catch (err) {
      console.error('connect failed', err);
    }
  }, []);

  const onDisconnect = useCallback(async () => {
    await disconnectWallet();
    setAddress(null);
    setBalance(null);
    setStableBalance(null);
    setBalanceError(null);
  }, []);

  // ── balance fetching ────────────────────────────────────────────────
  const refreshBalance = useCallback(async (a: string) => {
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const [{ balance: b, funded }, stable] = await Promise.all([
        fetchXlmBalance(a),
        STABLE_TOKEN_ID
          ? getStableBalance(a).catch(() => 0n)
          : Promise.resolve(0n),
      ]);
      if (!funded) {
        setBalance('0');
        setBalanceError(
          'Account not funded on testnet. Use friendbot to fund it.',
        );
      } else {
        setBalance(b);
      }
      if (STABLE_TOKEN_ID) setStableBalance(stroopsToXlm(stable));
    } catch (err) {
      setBalanceError((err as Error).message);
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    if (address) refreshBalance(address);
  }, [address, refreshBalance]);

  // ── derived split summary ───────────────────────────────────────────
  const summary = useMemo(() => {
    const cleanPayers = payers.map((p) => p.trim()).filter(Boolean);
    if (!totalXlm || cleanPayers.length === 0) return null;
    let totalStroops: bigint;
    try {
      totalStroops = xlmToStroops(totalXlm);
    } catch {
      return null;
    }
    let shares: bigint[];
    try {
      shares = computeShares(totalStroops, cleanPayers.length);
    } catch {
      return null;
    }
    return {
      totalStroops,
      shares,
      payers: cleanPayers,
    };
  }, [totalXlm, payers]);

  const validationError = useMemo(() => {
    const cleanPayers = payers.map((p) => p.trim()).filter(Boolean);
    if (!totalXlm.trim()) return null;
    try {
      xlmToStroops(totalXlm);
    } catch (err) {
      return (err as Error).message;
    }
    if (cleanPayers.length === 0) return 'Add at least one payer address.';
    for (const p of cleanPayers) {
      if (!isLikelyStellarAddress(p)) {
        return `Address "${shortAddr(p)}" doesn't look like a Stellar G… key.`;
      }
    }
    return null;
  }, [totalXlm, payers]);

  // ── L1 + (optional) L2 split flow ───────────────────────────────────
  const handleSplit = useCallback(async () => {
    if (!address) return;
    if (!summary || validationError) return;

    setSplitStatus({
      kind: 'progress',
      phase: 'preparing',
      label: PHASE_LABELS.preparing,
    });

    try {
      // L1: send N native-XLM payment ops in one tx.
      const payments = summary.payers.map((destination, i) => ({
        destination,
        amountStroops: summary.shares[i],
      }));
      const xlmHash = await sendXlmSplit({
        sender: address,
        payments,
        memo,
        onStatus: (phase) =>
          setSplitStatus({
            kind: 'progress',
            phase,
            label: PHASE_LABELS[phase],
          }),
      });

      // L2: optionally record the bill on-chain so payers can be tracked.
      let billId: number | undefined;
      if (recordOnChain && CONTRACT_ID) {
        // The first payer's share might absorb the rounding remainder; record
        // the floor share since on-chain we treat all payers symmetrically.
        const baseShare = summary.totalStroops / BigInt(summary.payers.length);
        const result = await createBill({
          sender: address,
          payers: summary.payers,
          shareStroops: baseShare,
          memo,
          onStatus: (phase) =>
            setSplitStatus({
              kind: 'progress',
              phase,
              label: PHASE_LABELS[phase],
            }),
        });
        billId = result.billId;
      }

      setSplitStatus({
        kind: 'success',
        hash: xlmHash,
        message:
          billId !== undefined
            ? `Split sent and recorded as bill #${billId}.`
            : 'Split sent.',
      });

      // Reset and refresh.
      setTotalXlm('');
      setMemo('');
      setPayers(['', '']);
      refreshBalance(address);
      if (CONTRACT_ID) loadBillsForCurrentUser(address);
    } catch (err) {
      const msg =
        err instanceof ContractError
          ? err.message
          : (err as Error).message || 'Unknown error';
      setSplitStatus({ kind: 'error', message: msg });
    }
  }, [address, summary, validationError, memo, recordOnChain, refreshBalance]);

  // ── contract reads: bills involving the connected wallet ────────────
  const loadBillsForCurrentUser = useCallback(async (a: string) => {
    if (!CONTRACT_ID) return;
    setBillsLoading(true);
    try {
      const count = await getBillCount();
      setBillCount(count);

      // Fetch all bills (small dApp, fine to scan from id=1). For prod scale
      // this would page or filter via bills_by_payer/by_creator.
      const out: Bill[] = [];
      for (let id = 1; id <= count; id++) {
        try {
          const b = await getBill(id);
          if (b.creator === a || b.payers.includes(a)) out.push(b);
        } catch (err) {
          console.warn(`getBill(${id}) failed`, err);
        }
      }
      // Newest first.
      out.reverse();
      setBills(out);

      // Bulk-load settled flags for visible payers.
      const settled: Record<string, boolean> = {};
      await Promise.all(
        out.flatMap((b) =>
          b.payers.map(async (p) => {
            try {
              settled[`${b.id}:${p}`] = await isSettled(b.id, p);
            } catch {
              /* leave as undefined → renders as "owes" */
            }
          }),
        ),
      );
      setSettledMap(settled);
    } catch (err) {
      console.error('loadBills failed', err);
    } finally {
      setBillsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (address && CONTRACT_ID) loadBillsForCurrentUser(address);
  }, [address, loadBillsForCurrentUser]);

  // ── event feed (poll every 5s) ──────────────────────────────────────
  const eventTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!CONTRACT_ID) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const evs = await fetchSettledEvents({ ledgersBack: 5_000, limit: 50 });
        if (!cancelled) setEvents(evs);
      } catch (err) {
        console.warn('event fetch failed', err);
      }
    };
    tick();
    eventTimer.current = window.setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      if (eventTimer.current !== null) window.clearInterval(eventTimer.current);
    };
  }, []);

  // ── settle flow ─────────────────────────────────────────────────────
  const handleSettle = useCallback(
    async (billId: number) => {
      if (!address) return;
      setSettleStatus({
        kind: 'progress',
        phase: 'preparing',
        label: PHASE_LABELS.preparing,
      });
      try {
        const hash = await settleBill({
          sender: address,
          billId,
          onStatus: (phase) =>
            setSettleStatus({
              kind: 'progress',
              phase,
              label: PHASE_LABELS[phase],
            }),
        });
        setSettleStatus({
          kind: 'success',
          hash,
          message: STABLE_TOKEN_ID
            ? `Paid ${STABLE_SYMBOL} share for bill #${billId} via inter-contract transfer.`
            : `Marked bill #${billId} as settled.`,
        });
        loadBillsForCurrentUser(address);
        refreshBalance(address);
      } catch (err) {
        const msg =
          err instanceof ContractError
            ? err.message
            : (err as Error).message || 'Unknown error';
        setSettleStatus({ kind: 'error', message: msg });
      }
    },
    [address, loadBillsForCurrentUser, refreshBalance],
  );

  // ── render ──────────────────────────────────────────────────────────
  return (
    <div className="app">
      <div className="header">
        <div className="title">
          <h1>Split Bill Calculator</h1>
          <p>
            Split a bill across N Stellar addresses on testnet.
            {CONTRACT_ID && ' Record bills on-chain via the BillSplit contract.'}
            {STABLE_TOKEN_ID &&
              ` Settles in ${STABLE_SYMBOL} via an inter-contract transfer.`}
          </p>
        </div>

        <div className="wallet-card">
          {address ? (
            <>
              <div>
                <div className="addr">{shortAddr(address)}</div>
                <div className="muted">
                  {balanceLoading ? (
                    <span className="skeleton" style={{ width: 60, display: 'inline-block' }} />
                  ) : (
                    <>
                      <span className="balance">{balance ?? '—'} XLM</span>
                      {STABLE_TOKEN_ID && stableBalance !== null && (
                        <>
                          {' · '}
                          <span className="balance">
                            {stableBalance} {STABLE_SYMBOL}
                          </span>
                        </>
                      )}
                    </>
                  )}
                </div>
                {balanceError && (
                  <div className="muted" style={{ color: 'var(--warn)' }}>
                    {balanceError}
                  </div>
                )}
              </div>
              <button
                className="ghost"
                onClick={() => address && refreshBalance(address)}
              >
                ↻
              </button>
              <button className="danger" onClick={onDisconnect}>
                Disconnect
              </button>
            </>
          ) : (
            <button onClick={onConnect}>Connect wallet</button>
          )}
        </div>
      </div>

      {!CONTRACT_ID && (
        <div className="panel" style={{ borderColor: 'var(--warn)' }}>
          <div className="hint">
            <strong>Heads up:</strong> <code>VITE_CONTRACT_ID</code> isn't set,
            so the on-chain bill-recording features are disabled. The L1 split
            flow (sending XLM to N addresses) still works. To enable contract
            features, deploy the bill-split contract and put its address in{' '}
            <code>frontend/.env</code>.
          </div>
        </div>
      )}

      <div className="panel">
        <h2>New split</h2>
        <p className="sub">
          Enter the total bill amount and the addresses paying it. Each payer
          gets an equal share; the last payer absorbs any sub-stroop rounding
          remainder.
        </p>

        <div className="row">
          <div>
            <label>Total amount (XLM)</label>
            <input
              type="text"
              inputMode="decimal"
              value={totalXlm}
              onChange={(e) => setTotalXlm(e.target.value)}
              placeholder="e.g. 12.5"
            />
          </div>
          <div>
            <label>Memo (optional, ≤28 chars)</label>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Pizza night"
              maxLength={28}
            />
          </div>
        </div>

        <label>Payers ({payers.length})</label>
        {payers.map((p, i) => (
          <div className="payer-row" key={i}>
            <input
              type="text"
              value={p}
              onChange={(e) => {
                const next = [...payers];
                next[i] = e.target.value;
                setPayers(next);
              }}
              placeholder="G..."
            />
            <button
              type="button"
              className="remove"
              onClick={() => setPayers(payers.filter((_, j) => j !== i))}
              disabled={payers.length <= 1}
              title="Remove this payer"
            >
              ×
            </button>
          </div>
        ))}
        <div className="actions">
          <button
            type="button"
            className="ghost"
            onClick={() => setPayers([...payers, ''])}
          >
            + Add payer
          </button>
          {address && CONTRACT_ID && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                margin: 0,
                color: 'var(--muted)',
                fontSize: '0.85rem',
              }}
            >
              <input
                type="checkbox"
                checked={recordOnChain}
                onChange={(e) => setRecordOnChain(e.target.checked)}
                style={{ width: 'auto', margin: 0 }}
              />
              Also record on-chain (extra signature)
            </label>
          )}
        </div>

        {summary && (
          <div className="summary">
            <span>
              <strong>Per payer:</strong>{' '}
              {stroopsToXlm(summary.totalStroops / BigInt(summary.payers.length))} XLM
            </span>
            <span>
              <strong>Total:</strong> {stroopsToXlm(summary.totalStroops)} XLM
            </span>
            <span>
              <strong>Payers:</strong> {summary.payers.length}
            </span>
          </div>
        )}

        {validationError && (
          <div className="status error">{validationError}</div>
        )}

        <div className="actions">
          <button
            onClick={handleSplit}
            disabled={
              !address ||
              !summary ||
              !!validationError ||
              splitStatus.kind === 'progress'
            }
          >
            {splitStatus.kind === 'progress' ? 'Working…' : 'Send split'}
          </button>
        </div>

        {splitStatus.kind === 'progress' && (
          <div className={`status ${splitStatus.phase}`}>
            {splitStatus.label}
          </div>
        )}
        {splitStatus.kind === 'success' && (
          <div className="status success">
            ✓ {splitStatus.message}{' '}
            <a
              href={explorerTxUrl(splitStatus.hash)}
              target="_blank"
              rel="noreferrer"
            >
              tx <code>{splitStatus.hash.slice(0, 10)}…</code>
            </a>
          </div>
        )}
        {splitStatus.kind === 'error' && (
          <div className="status error">✕ {splitStatus.message}</div>
        )}
      </div>

      {CONTRACT_ID && address && (
        <div className="panel">
          <h2>Your bills</h2>
          <p className="sub">
            Bills you created or were named in.{' '}
            {STABLE_TOKEN_ID
              ? `Settling pulls your share in ${STABLE_SYMBOL} from your wallet → the bill creator via an inter-contract token::transfer.`
              : 'Settle just records on-chain — no funds move.'}
            {billCount !== null && (
              <span className="hint">
                {' '}
                ({billCount} bill{billCount === 1 ? '' : 's'} on-chain in total
                — <a href={explorerContractUrl(CONTRACT_ID)} target="_blank" rel="noreferrer">contract</a>)
              </span>
            )}
          </p>

          {billsLoading && bills.length === 0 ? (
            <>
              <div className="skeleton" style={{ height: 60, marginBottom: 8 }} />
              <div className="skeleton" style={{ height: 60 }} />
            </>
          ) : bills.length === 0 ? (
            <div className="hint">No bills involving this wallet yet.</div>
          ) : (
            <div className="bill-list">
              {bills.map((b) => {
                const youArePayer = b.payers.includes(address);
                const yourSettled = settledMap[`${b.id}:${address}`];
                return (
                  <div className="bill-item" key={b.id}>
                    <header>
                      <div>
                        <strong>Bill #{b.id}</strong>
                        {b.memo && <> · {b.memo}</>}
                      </div>
                      <div className="meta">
                        {stroopsToXlm(b.share)} XLM × {b.payers.length} ={' '}
                        {stroopsToXlm(b.share * BigInt(b.payers.length))} XLM
                      </div>
                    </header>
                    <div className="payers">
                      {b.payers.map((p) => {
                        const paid = settledMap[`${b.id}:${p}`];
                        return (
                          <div className="payer" key={p}>
                            <span>
                              {p === b.creator ? '👑 ' : ''}
                              {shortAddr(p)}
                              {p === address && ' (you)'}
                            </span>
                            <span
                              className={`pill ${paid ? 'paid' : 'owes'}`}
                            >
                              {paid ? 'paid' : 'owes'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    {youArePayer && !yourSettled && (
                      <div className="actions">
                        <button
                          onClick={() => handleSettle(b.id)}
                          disabled={settleStatus.kind === 'progress'}
                        >
                          {STABLE_TOKEN_ID
                            ? `Pay ${stroopsToXlm(b.share)} ${STABLE_SYMBOL} & settle`
                            : 'Mark my share settled'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {settleStatus.kind === 'progress' && (
            <div className={`status ${settleStatus.phase}`}>
              {settleStatus.label}
            </div>
          )}
          {settleStatus.kind === 'success' && (
            <div className="status success">
              ✓ {settleStatus.message}{' '}
              <a
                href={explorerTxUrl(settleStatus.hash)}
                target="_blank"
                rel="noreferrer"
              >
                tx <code>{settleStatus.hash.slice(0, 10)}…</code>
              </a>
            </div>
          )}
          {settleStatus.kind === 'error' && (
            <div className="status error">✕ {settleStatus.message}</div>
          )}
        </div>
      )}

      {CONTRACT_ID && (
        <div className="panel">
          <h2>Live settlement feed</h2>
          <p className="sub">
            Real-time stream of <code>settled</code> events emitted by the
            contract. Polled every 5 s.
          </p>
          {events.length === 0 ? (
            <div className="hint">No settlements yet.</div>
          ) : (
            <div className="event-feed">
              {events.map((e) => (
                <div className="event-item" key={e.id}>
                  <span>
                    <span className="who">{shortAddr(e.payer)}</span> settled{' '}
                    <strong>bill #{e.billId}</strong> for{' '}
                    <strong>{stroopsToXlm(e.share)} XLM</strong>
                  </span>
                  <span className="ts">
                    {new Date(e.ledgerClosedAt).toLocaleTimeString()}{' '}
                    {e.txHash && (
                      <a
                        href={explorerTxUrl(e.txHash)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        ↗
                      </a>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
