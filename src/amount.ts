import { UnboundStellarError } from './errors.js';

export const SCALE = 7;
const UNIT = 10n ** BigInt(SCALE);
/** Max int64, the ledger limit for amounts. */
export const MAX_AMOUNT = 9223372036854775807n;

/** Parse a decimal string (max 7 decimals) into integer base units. No floats anywhere. */
export function parseAmount(text: string, opts: { allowZero?: boolean } = {}): bigint {
  if (typeof text !== 'string' || !/^\d+(\.\d{1,7})?$/.test(text)) {
    throw new UnboundStellarError('INVALID_AMOUNT', 'amount must be a non-negative decimal with at most 7 decimal places');
  }
  const [whole = '0', frac = ''] = text.split('.');
  const value = BigInt(whole) * UNIT + BigInt(frac.padEnd(SCALE, '0'));
  if (value > MAX_AMOUNT) throw new UnboundStellarError('INVALID_AMOUNT', 'amount exceeds ledger maximum');
  if (value === 0n && !opts.allowZero) throw new UnboundStellarError('INVALID_AMOUNT', 'amount must be greater than zero');
  return value;
}

/** Format base units as a 7-decimal string, as Stellar expects in operations. */
export function formatAmount(units: bigint): string {
  if (units < 0n) throw new UnboundStellarError('INVALID_AMOUNT', 'negative amount');
  const whole = units / UNIT;
  const frac = (units % UNIT).toString().padStart(SCALE, '0');
  return `${whole}.${frac}`;
}
