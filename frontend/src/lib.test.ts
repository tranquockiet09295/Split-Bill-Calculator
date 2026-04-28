import { describe, expect, it } from 'vitest';
import {
  ContractError,
  computeShares,
  decodeSimError,
  isLikelyStellarAddress,
  stroopsToXlm,
  xlmToStroops,
} from './lib';

describe('xlmToStroops', () => {
  it('converts whole XLM amounts to stroops', () => {
    expect(xlmToStroops('1')).toBe(10_000_000n);
    expect(xlmToStroops('100')).toBe(1_000_000_000n);
  });

  it('converts fractional XLM up to 7 decimals', () => {
    expect(xlmToStroops('0.5')).toBe(5_000_000n);
    expect(xlmToStroops('1.2345678')).toBe(12_345_678n);
  });

  it('throws ContractError(validation) for non-numeric input', () => {
    expect(() => xlmToStroops('abc')).toThrow(ContractError);
    try {
      xlmToStroops('abc');
    } catch (err) {
      expect((err as ContractError).category).toBe('validation');
    }
  });

  it('throws for zero or negative amount', () => {
    expect(() => xlmToStroops('0')).toThrow(/greater than 0/);
    expect(() => xlmToStroops('-1')).toThrow(ContractError);
  });
});

describe('stroopsToXlm', () => {
  it('formats whole-stroop amounts without trailing decimals', () => {
    expect(stroopsToXlm(10_000_000n)).toBe('1');
  });

  it('preserves fractional XLM and strips trailing zeros', () => {
    expect(stroopsToXlm(5_000_000n)).toBe('0.5');
    expect(stroopsToXlm(1n)).toBe('0.0000001');
  });

  it('round-trips with xlmToStroops', () => {
    for (const xlm of ['0.5', '1', '7.25', '0.0000001', '12345']) {
      expect(stroopsToXlm(xlmToStroops(xlm))).toBe(xlm);
    }
  });
});

describe('computeShares', () => {
  it('splits evenly when divisible', () => {
    const shares = computeShares(30_000_000n, 3);
    expect(shares).toEqual([10_000_000n, 10_000_000n, 10_000_000n]);
  });

  it('puts the remainder on the last payer so the sum equals the total', () => {
    const total = 100_000_001n; // 10.0000001 XLM
    const shares = computeShares(total, 3);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(total);
    // First two get the floor, last gets the remainder.
    expect(shares[0]).toBe(33_333_333n);
    expect(shares[1]).toBe(33_333_333n);
    expect(shares[2]).toBe(33_333_335n);
  });

  it('throws on zero total or zero payers', () => {
    expect(() => computeShares(0n, 3)).toThrow(ContractError);
    expect(() => computeShares(10n, 0)).toThrow(ContractError);
  });
});

describe('isLikelyStellarAddress', () => {
  it('accepts a well-formed G address', () => {
    expect(
      isLikelyStellarAddress(
        'GCVNQZPI76QNMDKFC5DVDXHUXFVM3ABHARWJ4DOFFACQ4F2E6KYYH63A',
      ),
    ).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(isLikelyStellarAddress('GABC')).toBe(false);
    expect(isLikelyStellarAddress('not an address')).toBe(false);
    expect(
      isLikelyStellarAddress(
        'CCJ62UKISYB5I5UIPIRHVO7YZ4BZVB7F2UY4NZDC6ILNEHRWIMFT4PCS',
      ),
    ).toBe(false); // C-prefixed (contract) is not a wallet address
  });

  it('trims whitespace before validating', () => {
    expect(
      isLikelyStellarAddress(
        '   GCVNQZPI76QNMDKFC5DVDXHUXFVM3ABHARWJ4DOFFACQ4F2E6KYYH63A  ',
      ),
    ).toBe(true);
  });
});

describe('decodeSimError', () => {
  it('translates contract panics into user-readable messages', () => {
    expect(decodeSimError('panic: share must be positive')).toMatch(
      /greater than 0/,
    );
    expect(decodeSimError('panic: payers required')).toMatch(/At least one/);
    expect(decodeSimError('address is not a payer on this bill')).toMatch(
      /not a payer/,
    );
    expect(decodeSimError('already settled')).toMatch(/already settled/);
  });

  it('falls back to a truncated raw message when nothing matches', () => {
    const long = 'X'.repeat(500);
    const decoded = decodeSimError(long);
    expect(decoded.startsWith('Simulation failed: ')).toBe(true);
    expect(decoded.length).toBeLessThan(280);
  });
});

describe('ContractError', () => {
  it('captures message and category', () => {
    const err = new ContractError('boom', 'rejected');
    expect(err.message).toBe('boom');
    expect(err.category).toBe('rejected');
    expect(err.name).toBe('ContractError');
    expect(err).toBeInstanceOf(Error);
  });
});
