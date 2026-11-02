import { describe, expect, it } from 'vitest';
import { SubmitTimeoutError } from '../src/errors.js';
import { mapAccount, mapPath, mapSubmitError, mapTx } from '../src/rpc/horizon.js';
import { classifyRejection } from '../src/settlement/submit.js';

// NOTE: payloads are HAND-WRITTEN following the public Horizon shape; they are not recorded responses.
const ISSUER = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

describe('Horizon mapping (hand-written fixtures)', () => {
  it('maps accounts: native, credit lines, flags, skips pool shares', () => {
    const a = mapAccount({
      id: ISSUER,
      sequence: '123',
      flags: { auth_required: true, auth_revocable: true, auth_immutable: false },
      balances: [
        { asset_type: 'native', balance: '9.9999900' },
        { asset_type: 'credit_alphanum4', asset_code: 'SHOP', asset_issuer: ISSUER, balance: '80.0000000', limit: '1000.0000000', is_authorized: false },
        { asset_type: 'liquidity_pool_shares', balance: '1.0000000' },
      ],
    });
    expect(a.flags).toEqual({ authRequired: true, authRevocable: true, authImmutable: false, authClawbackEnabled: false });
    expect(a.balances).toHaveLength(2);
    expect(a.balances[1]).toMatchObject({ balance: 800000000n, limit: 10000000000n, isAuthorized: false });
  });
  it('maps path records', () => {
    const p = mapPath({ destination_amount: '72.0000000', path: [{ asset_type: 'native' }] });
    expect(p).toEqual({ path: [{ code: 'XLM', issuer: null }], destinationAmount: 720000000n });
  });
  it('maps transactions', () => {
    expect(mapTx({ hash: 'h', ledger: 5, successful: false, paging_token: 'p', created_at: '2026-11-02T00:00:00Z' })).toMatchObject({ successful: false, pagingToken: 'p' });
  });
  it('treats only a 400 with result codes as a definitive rejection', () => {
    const r = mapSubmitError('h', { response: { status: 400, data: { extras: { result_codes: { transaction: 'tx_failed', operations: ['op_under_dest_min'] } } } } });
    expect(r).toMatchObject({ status: 'REJECTED' });
    expect(classifyRejection((r as { codes: { transaction: string; operations: string[] } }).codes)).toBe('MIN_OUTPUT_VIOLATION');
  });
  it.each([
    ['504 gateway timeout', { response: { status: 504 } }],
    ['no response at all', new Error('ECONNRESET')],
    ['500 server error', { response: { status: 500, data: {} } }],
    ['400 without codes', { response: { status: 400, data: {} } }],
  ])('treats %s as an unknown outcome', (_n, err) => {
    expect(() => mapSubmitError('h', err)).toThrow(SubmitTimeoutError);
  });
  it('classifies other result codes', () => {
    expect(classifyRejection({ transaction: 'tx_bad_seq', operations: [] })).toBe('BAD_SEQUENCE');
    expect(classifyRejection({ transaction: 'tx_failed', operations: ['op_no_trust'] })).toBe('NO_TRUSTLINE');
    expect(classifyRejection({ transaction: 'tx_failed', operations: ['op_not_authorized'] })).toBe('TRUSTLINE_UNAUTHORIZED');
    expect(classifyRejection({ transaction: 'tx_failed', operations: ['op_line_full'] })).toBe('TRUSTLINE_LIMIT_EXCEEDED');
    expect(classifyRejection({ transaction: 'tx_weird', operations: [] })).toBe('REJECTED_OTHER');
  });
});
