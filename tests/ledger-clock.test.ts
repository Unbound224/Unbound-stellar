import { describe, expect, it, vi } from 'vitest';
import { LedgerClock } from '../src/rpc/ledger-clock.js';

const reply = (date?: string) => vi.fn().mockResolvedValue({ headers: new Headers(date ? { date } : {}) });

describe('LedgerClock', () => {
  it('corrects a host clock that runs ~90 s slow so a fresh maxTime is not already past on the ledger', async () => {
    const hostNow = () => Date.parse('2026-11-04T16:40:19.000Z');
    const c = new LedgerClock('https://horizon.test', reply('Wed, 04 Nov 2026 16:41:50 GMT') as unknown as typeof fetch, hostNow);
    await c.sync();
    expect(c.offset).toBe(91_000);
    expect(c.now()).toBe(Date.parse('2026-11-04T16:41:50.000Z'));
  });

  it('keeps the previous offset when the server is unreachable or sends no Date header', async () => {
    const c = new LedgerClock('https://horizon.test', vi.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch, () => 1000);
    expect(await c.sync()).toBe(0);
    const d = new LedgerClock('https://horizon.test', reply() as unknown as typeof fetch, () => 1000);
    expect(await d.sync()).toBe(0);
    expect(d.now()).toBe(1000);
  });
});
