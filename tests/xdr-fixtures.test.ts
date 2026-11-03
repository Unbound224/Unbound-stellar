import { readFileSync } from 'node:fs';
import { Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { generateXdrFixtures } from '../scripts/xdr-fixtures.js';
import { TESTNET_PASSPHRASE } from '../src/types/index.js';

describe('XDR fixtures for downstream decoders', () => {
  it('checked-in file equals a fresh deterministic generation (regenerate with npx tsx scripts/generate-xdr-fixtures.ts)', async () => {
    const onDisk = readFileSync(new URL('../fixtures/xdr/transactions.v1.json', import.meta.url), 'utf8');
    expect(onDisk).toBe(JSON.stringify(await generateXdrFixtures(), null, 2) + '\n');
  });
  it('fixtures decode to the operations downstream apps expect', async () => {
    const f = (await generateXdrFixtures()) as { settlement: { xdr: string; signedXdr: string; hash: string }; redemptionReturn: { xdr: string; hash: string } };
    const s = TransactionBuilder.fromXDR(f.settlement.xdr, TESTNET_PASSPHRASE) as Transaction;
    expect(s.operations.map((o) => o.type)).toEqual(['pathPaymentStrictSend']);
    expect(Buffer.from(s.hash()).toString('hex')).toBe(f.settlement.hash);
    expect(s.signatures).toHaveLength(0);
    expect((TransactionBuilder.fromXDR(f.settlement.signedXdr, TESTNET_PASSPHRASE) as Transaction).signatures).toHaveLength(1);
    expect((TransactionBuilder.fromXDR(f.redemptionReturn.xdr, TESTNET_PASSPHRASE) as Transaction).operations.map((o) => o.type)).toEqual(['payment']);
    const g = f as unknown as { escrowOpen: { xdr: string; hash: string }; escrowExpire: { xdr: string } };
    const open = TransactionBuilder.fromXDR(g.escrowOpen.xdr, TESTNET_PASSPHRASE) as Transaction;
    expect(open.operations.map((o) => o.type)).toEqual(['invokeHostFunction']);
    expect(Buffer.from(open.hash()).toString('hex')).toBe(g.escrowOpen.hash);
    expect((TransactionBuilder.fromXDR(g.escrowExpire.xdr, TESTNET_PASSPHRASE) as Transaction).operations.map((o) => o.type)).toEqual(['invokeHostFunction']);
  });
});
