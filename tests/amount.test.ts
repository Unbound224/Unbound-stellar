import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '../src/amount.js';

describe('amount', () => {
  it('round-trips 7-decimal values exactly', () => {
    expect(parseAmount('80')).toBe(800000000n);
    expect(parseAmount('0.0000001')).toBe(1n);
    expect(formatAmount(parseAmount('72.5'))).toBe('72.5000000');
    expect(formatAmount(1n)).toBe('0.0000001');
  });
  it('is exact where floats are not', () => {
    expect(parseAmount('0.1') + parseAmount('0.2')).toBe(parseAmount('0.3'));
  });
  it.each(['', '-1', '1e3', '1.12345678', 'abc', '1.', '.5', ' 1'])('rejects %j', (s) => {
    expect(() => parseAmount(s)).toThrowError(/amount/);
  });
  it('rejects zero unless allowed and anything above int64', () => {
    expect(() => parseAmount('0')).toThrow();
    expect(parseAmount('0', { allowZero: true })).toBe(0n);
    expect(() => parseAmount('922337203685.4775808')).toThrow(/maximum/);
    expect(parseAmount('922337203685.4775807')).toBe(9223372036854775807n);
  });
});
