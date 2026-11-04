/**
 * Clock anchored to the network instead of the host. Stellar rejects a transaction whose maxTime is already past on
 * LEDGER time, so a host clock that runs slow makes every freshly built settlement `tx_too_late`. This estimates the
 * offset between the host clock and the Horizon server's `Date` header (1 second resolution) and applies it.
 */
export class LedgerClock {
  private offsetMs = 0;
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly hostNow: () => number = Date.now,
  ) {}

  /** Never throws: on any failure the previous offset (initially 0) stays in force. */
  async sync(): Promise<number> {
    try {
      const before = this.hostNow();
      const res = await this.fetchImpl(this.url, { method: 'GET' });
      const after = this.hostNow();
      const date = res.headers.get('date');
      const server = date ? Date.parse(date) : NaN;
      if (Number.isFinite(server)) this.offsetMs = server - Math.floor((before + after) / 2);
    } catch {
      /* keep the previous offset */
    }
    return this.offsetMs;
  }

  get offset(): number {
    return this.offsetMs;
  }

  now = (): number => this.hostNow() + this.offsetMs;
}
