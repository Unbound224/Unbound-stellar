/**
 * SimulatedLedger - an IN-MEMORY TEST ADAPTER. It is NOT Stellar consensus and NOT a Testnet
 * connection. It decodes and verifies REAL transaction XDR (network passphrase, signature,
 * sequence, timebounds) and applies a small subset of classic operations (payment, changeTrust,
 * setOptions, setTrustLineFlags, pathPaymentStrictSend over fixed-price offers) with the
 * documented result codes, so failure paths can be exercised deterministically offline.
 * Anything it does not model (partial offer crossing, reserves, liabilities) is out of scope and
 * must be verified against real Testnet.
 */
import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { parseAmount } from '../amount.js';
import { SubmitTimeoutError } from '../errors.js';
import type {
  LedgerEventPage,
  LedgerEventSource,
  LedgerReader,
  PathCandidate,
  PathSource,
  SubmitResult,
  Submitter,
  TransactionLookup,
  TxRecord,
} from '../ports.js';
import { assetKey, TESTNET_PASSPHRASE, type AccountFlags, type AccountSnapshot, type AssetRef, NATIVE } from '../types/index.js';

const FLAG_AUTH_REQUIRED = 1;
const FLAG_AUTH_REVOCABLE = 2;
const FLAG_AUTH_IMMUTABLE = 4;
const FLAG_CLAWBACK = 8;

interface Line {
  asset: AssetRef;
  balance: bigint;
  limit: bigint | null;
  authorized: boolean;
}
interface Account {
  seq: bigint;
  flags: number;
  lines: Map<string, Line>;
}
export interface Offer {
  id: number;
  seller: string;
  selling: AssetRef;
  buying: AssetRef;
  /** remaining amount of `selling`, base units */
  amount: bigint;
  /** price = buying units per 1 selling unit = n/d */
  n: bigint;
  d: bigint;
}

type FailNext = 'timeout-after-apply' | 'timeout-before-apply' | null;

class OpFail extends Error {
  constructor(readonly opCode: string) {
    super(opCode);
  }
}

export class SimulatedLedger implements LedgerReader, PathSource, Submitter, TransactionLookup, LedgerEventSource {
  readonly networkPassphrase = TESTNET_PASSPHRASE;
  private accounts = new Map<string, Account>();
  private offers: Offer[] = [];
  private nextOfferId = 1;
  private ledgerSeq = 1000;
  private records: TxRecord[] = [];
  private byHash = new Map<string, TxRecord>();
  private failNext: FailNext = null;
  /** submissions attempted, for assertions on idempotency */
  submitCalls = 0;

  constructor(private readonly nowMs: () => number = Date.now) {}

  // ---- test setup helpers (not part of any port) ----
  createAccount(id: string, xlm = 10_000n * 10_000_000n): void {
    this.accounts.set(id, { seq: 1n, flags: 0, lines: new Map([['native', { asset: NATIVE, balance: xlm, limit: null, authorized: true }]]) });
  }
  setBalance(id: string, asset: AssetRef, balance: bigint): void {
    const a = this.mustAccount(id);
    const k = assetKey(asset);
    const line = a.lines.get(k) ?? { asset, balance: 0n, limit: (1n << 62n), authorized: true };
    line.balance = balance;
    a.lines.set(k, line);
  }
  addOffer(o: Omit<Offer, 'id'>): Offer {
    const offer = { ...o, id: this.nextOfferId++ };
    this.offers.push(offer);
    return offer;
  }
  clearOffers(): void {
    this.offers = [];
  }
  balanceOf(id: string, asset: AssetRef): bigint {
    return this.accounts.get(id)?.lines.get(assetKey(asset))?.balance ?? 0n;
  }
  injectNextSubmit(mode: FailNext): void {
    this.failNext = mode;
  }
  get currentLedger(): number {
    return this.ledgerSeq;
  }

  // ---- LedgerReader ----
  async loadAccount(id: string): Promise<AccountSnapshot | null> {
    const a = this.accounts.get(id);
    if (!a) return null;
    const flags: AccountFlags = {
      authRequired: (a.flags & FLAG_AUTH_REQUIRED) !== 0,
      authRevocable: (a.flags & FLAG_AUTH_REVOCABLE) !== 0,
      authImmutable: (a.flags & FLAG_AUTH_IMMUTABLE) !== 0,
      authClawbackEnabled: (a.flags & FLAG_CLAWBACK) !== 0,
    };
    return {
      id,
      sequence: a.seq.toString(),
      flags,
      balances: [...a.lines.values()].map((l) => ({ asset: l.asset, balance: l.balance, limit: l.limit, isAuthorized: l.authorized })),
    };
  }

  // ---- PathSource ----
  async findStrictSendPaths(source: AssetRef, sourceAmount: bigint, destination: AssetRef): Promise<PathCandidate[]> {
    const mids = new Map<string, AssetRef>();
    for (const o of this.offers) {
      for (const a of [o.selling, o.buying]) {
        if (assetKey(a) !== assetKey(source) && assetKey(a) !== assetKey(destination)) mids.set(assetKey(a), a);
      }
    }
    const routes: AssetRef[][] = [[], ...[...mids.values()].map((m) => [m])];
    const out: PathCandidate[] = [];
    for (const path of routes) {
      const hops = [source, ...path, destination];
      let amt = sourceAmount;
      let ok = true;
      for (let i = 0; i < hops.length - 1 && ok; i++) {
        const r = this.walk(hops[i]!, hops[i + 1]!, amt);
        if (r.out === 0n) ok = false;
        amt = r.out;
      }
      if (ok && amt > 0n) out.push({ path, destinationAmount: amt });
    }
    return out;
  }

  // ---- Submitter ----
  async submit(signedXdr: string): Promise<SubmitResult> {
    this.submitCalls++;
    if (this.failNext === 'timeout-before-apply') {
      this.failNext = null;
      throw new SubmitTimeoutError();
    }
    const result = this.apply(signedXdr);
    if (this.failNext === 'timeout-after-apply') {
      this.failNext = null;
      throw new SubmitTimeoutError();
    }
    return result;
  }

  // ---- TransactionLookup ----
  async getTransaction(hash: string): Promise<TxRecord | null> {
    return this.byHash.get(hash) ?? null;
  }

  // ---- LedgerEventSource (paging token = record index, as a string) ----
  async fetch(cursor: string, limit: number): Promise<LedgerEventPage> {
    const start = Number(cursor);
    const events = this.records.slice(start, start + limit);
    return { events, nextCursor: String(start + events.length) };
  }

  // ---- internals ----
  private mustAccount(id: string): Account {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`test setup: unknown account ${id}`);
    return a;
  }

  private sortedOffers(selling: AssetRef, buying: AssetRef): Offer[] {
    return this.offers
      .filter((o) => assetKey(o.selling) === assetKey(selling) && assetKey(o.buying) === assetKey(buying) && o.amount > 0n)
      .sort((x, y) => Number(x.n * y.d - y.n * x.d));
  }

  /** Spend `amountIn` of `have`, receive as much `want` as the book allows. Pure (no mutation). */
  private walk(have: AssetRef, want: AssetRef, amountIn: bigint) {
    let remaining = amountIn;
    let out = 0n;
    const fills: { offer: Offer; take: bigint; pay: bigint }[] = [];
    for (const o of this.sortedOffers(want, have)) {
      if (remaining <= 0n) break;
      const wantable = (remaining * o.d) / o.n; // floor
      const take = wantable < o.amount ? wantable : o.amount;
      if (take <= 0n) continue;
      const pay = (take * o.n + o.d - 1n) / o.d; // ceil of what the seller is owed
      const spent = pay > remaining ? remaining : pay;
      fills.push({ offer: o, take, pay: spent });
      out += take;
      remaining -= spent;
    }
    return { out, fills, spent: amountIn - remaining };
  }

  private record(hash: string, successful: boolean, amountOut?: bigint): TxRecord {
    this.ledgerSeq++;
    const rec: TxRecord = {
      hash,
      ledger: this.ledgerSeq,
      successful,
      pagingToken: String(this.records.length + 1),
      observedAt: new Date(this.nowMs()).toISOString(),
      ...(amountOut !== undefined ? { amountOutActual: amountOut } : {}),
    };
    this.records.push(rec);
    this.byHash.set(hash, rec);
    return rec;
  }

  private apply(signedXdr: string): SubmitResult {
    let tx: Transaction;
    try {
      tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;
    } catch {
      return { status: 'REJECTED', hash: '', codes: { transaction: 'tx_malformed', operations: [] } };
    }
    const hash = Buffer.from(tx.hash()).toString('hex');
    const rej = (transaction: string): SubmitResult => ({ status: 'REJECTED', hash, codes: { transaction, operations: [] } });

    if (this.byHash.has(hash)) return rej('tx_bad_seq'); // replay of an already-applied tx
    const src = this.accounts.get(tx.source);
    if (!src) return rej('tx_no_source_account');
    const kp = Keypair.fromPublicKey(tx.source);
    if (!tx.signatures.some((s) => kp.verify(tx.hash(), s.signature))) {
      return rej('tx_bad_auth');
    }
    if (BigInt(tx.sequence) !== src.seq + 1n) return rej('tx_bad_seq');
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    if (maxTime !== 0 && this.nowMs() / 1000 > maxTime) return rej('tx_too_late');
    const fee = BigInt(tx.fee);
    const xlm = src.lines.get('native')!;
    if (xlm.balance < fee) return rej('tx_insufficient_balance');

    // fee is charged and sequence consumed even if an operation fails (as on the real network)
    xlm.balance -= fee;
    src.seq += 1n;
    const snapshot = this.snapshot();
    try {
      let out: bigint | undefined;
      for (const op of tx.operations) {
        const r = this.applyOp(tx.source, op as unknown as Record<string, unknown>);
        if (r !== undefined) out = r;
      }
      const rec = this.record(hash, true, out);
      return { status: 'SUCCESS', hash, ledger: rec.ledger, ...(out !== undefined ? { amountOutActual: out } : {}) };
    } catch (e) {
      if (!(e instanceof OpFail)) throw e;
      this.restore(snapshot);
      this.record(hash, false);
      return { status: 'REJECTED', hash, codes: { transaction: 'tx_failed', operations: [e.opCode] } };
    }
  }

  private snapshot() {
    const accounts = new Map<string, Account>();
    for (const [k, a] of this.accounts) {
      accounts.set(k, { seq: a.seq, flags: a.flags, lines: new Map([...a.lines].map(([lk, l]) => [lk, { ...l }])) });
    }
    return { accounts, offers: this.offers.map((o) => ({ ...o })) };
  }
  private restore(s: ReturnType<SimulatedLedger["snapshot"]>) {
    this.accounts = s.accounts;
    this.offers = s.offers;
  }

  private issuerOf(a: AssetRef): Account | undefined {
    return a.issuer ? this.accounts.get(a.issuer) : undefined;
  }

  private debit(id: string, asset: AssetRef, amount: bigint, failCode = 'op_underfunded'): void {
    if (asset.issuer === id) return; // issuer mints
    const line = this.mustLine(id, asset, 'op_src_no_trust');
    if (!line.authorized) throw new OpFail('op_src_not_authorized');
    if (line.balance < amount) throw new OpFail(failCode);
    line.balance -= amount;
  }
  private credit(id: string, asset: AssetRef, amount: bigint): void {
    if (asset.issuer === id) return; // returned to issuer = burn
    const acct = this.accounts.get(id);
    if (!acct) throw new OpFail('op_no_destination');
    const line = acct.lines.get(assetKey(asset));
    if (!line) throw new OpFail('op_no_trust');
    if (!line.authorized) throw new OpFail('op_not_authorized');
    if ((line.limit ?? 0n) - line.balance < amount) throw new OpFail('op_line_full');
    line.balance += amount;
  }
  private mustLine(id: string, asset: AssetRef, code: string): Line {
    const line = this.accounts.get(id)?.lines.get(assetKey(asset));
    if (!line) throw new OpFail(code);
    return line;
  }

  private applyOp(source: string, op: Record<string, unknown>): bigint | undefined {
    const toRef = (a: { code: string; issuer?: string }): AssetRef => (a.issuer ? { code: a.code, issuer: a.issuer } : NATIVE);
    switch (op.type) {
      case 'payment': {
        const asset = toRef(op.asset as { code: string; issuer?: string });
        const amt = parseAmount(op.amount as string);
        this.debit(source, asset, amt);
        this.credit(op.destination as string, asset, amt);
        return undefined;
      }
      case 'changeTrust': {
        const asset = toRef(op.line as { code: string; issuer?: string });
        const issuer = this.issuerOf(asset);
        if (!issuer) throw new OpFail('op_no_issuer');
        const acct = this.mustAccount(source);
        const key = assetKey(asset);
        const limit = parseAmount(op.limit as string, { allowZero: true });
        const existing = acct.lines.get(key);
        if (existing) {
          if (limit < existing.balance) throw new OpFail('op_invalid_limit');
          existing.limit = limit;
        } else {
          acct.lines.set(key, { asset, balance: 0n, limit, authorized: (issuer.flags & FLAG_AUTH_REQUIRED) === 0 });
        }
        return undefined;
      }
      case 'setOptions': {
        const acct = this.mustAccount(source);
        if ((acct.flags & FLAG_AUTH_IMMUTABLE) !== 0) throw new OpFail('op_cant_change');
        if (typeof op.setFlags === 'number') acct.flags |= op.setFlags;
        return undefined;
      }
      case 'setTrustLineFlags': {
        const asset = toRef(op.asset as { code: string; issuer?: string });
        if (asset.issuer !== source) throw new OpFail('op_malformed');
        const line = this.accounts.get(op.trustor as string)?.lines.get(assetKey(asset));
        if (!line) throw new OpFail('op_no_trust_line');
        const flags = op.flags as { authorized?: boolean };
        if (flags.authorized === false && (this.mustAccount(source).flags & FLAG_AUTH_REVOCABLE) === 0) throw new OpFail('op_cant_revoke');
        if (flags.authorized !== undefined) line.authorized = flags.authorized;
        return undefined;
      }
      case 'pathPaymentStrictSend': {
        const send = toRef(op.sendAsset as { code: string; issuer?: string });
        const dest = toRef(op.destAsset as { code: string; issuer?: string });
        const path = (op.path as { code: string; issuer?: string }[]).map(toRef);
        const sendAmt = parseAmount(op.sendAmount as string);
        const destMin = parseAmount(op.destMin as string);
        const hops = [send, ...path, dest];
        // validate destination before touching the book
        const destAcct = this.accounts.get(op.destination as string);
        if (!destAcct) throw new OpFail('op_no_destination');
        this.debit(source, send, sendAmt);
        let amt = sendAmt;
        for (let i = 0; i < hops.length - 1; i++) {
          const r = this.walk(hops[i]!, hops[i + 1]!, amt);
          if (r.out === 0n) throw new OpFail('op_too_few_offers');
          for (const f of r.fills) {
            f.offer.amount -= f.take;
            // seller gives `take` of hops[i+1], receives `pay` of hops[i]
            this.adjustSeller(f.offer.seller, hops[i + 1]!, -f.take);
            this.adjustSeller(f.offer.seller, hops[i]!, f.pay);
          }
          amt = r.out;
        }
        if (amt < destMin) throw new OpFail('op_under_dest_min');
        this.credit(op.destination as string, dest, amt);
        return amt;
      }
      default:
        throw new OpFail('op_not_supported_by_simulator');
    }
  }

  private adjustSeller(id: string, asset: AssetRef, delta: bigint): void {
    if (asset.issuer === id) return;
    const line = this.accounts.get(id)?.lines.get(assetKey(asset));
    if (!line) throw new OpFail('op_seller_unfunded');
    if (line.balance + delta < 0n) throw new OpFail('op_seller_unfunded');
    line.balance += delta;
  }
}
