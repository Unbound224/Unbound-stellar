import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NETWORK_NAME, type ReconciliationStatus } from '../types/index.js';

export const RECONCILIATION_SCHEMA_VERSION = '1.0';

/** Reconciliation event contract from docs/ARCHITECTURE.md, versioned. */
export const ReconciliationEventSchema = z
  .object({
    id: z.string().min(1),
    sourceRepo: z.literal('unbound-stellar'),
    schemaVersion: z.literal(RECONCILIATION_SCHEMA_VERSION),
    network: z.literal(NETWORK_NAME),
    ledgerCursor: z.string().min(1),
    entityRef: z.object({ type: z.literal('transaction'), ref: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    status: z.enum(['CONFIRMED', 'FAILED', 'RECONCILING']),
    observedAt: z.iso.datetime(),
    ledger: z.number().int().nonnegative().optional(),
    amountOutActual: z.string().regex(/^\d+\.\d{7}$/).optional(),
  })
  .strict();

export type ReconciliationEvent = z.infer<typeof ReconciliationEventSchema>;

/** Deterministic id: duplicates of the same observation collapse (dedup key = network + hash). */
export function eventId(hash: string): string {
  return 'evt_' + createHash('sha256').update(`${NETWORK_NAME}:${hash}`).digest('hex').slice(0, 32);
}

export function makeEvent(args: {
  hash: string;
  status: ReconciliationStatus;
  ledgerCursor: string;
  observedAt: string;
  ledger?: number;
  amountOutActual?: string;
}): ReconciliationEvent {
  return ReconciliationEventSchema.parse({
    id: eventId(args.hash),
    sourceRepo: 'unbound-stellar',
    schemaVersion: RECONCILIATION_SCHEMA_VERSION,
    network: NETWORK_NAME,
    ledgerCursor: args.ledgerCursor,
    entityRef: { type: 'transaction', ref: args.hash },
    status: args.status,
    observedAt: args.observedAt,
    ...(args.ledger !== undefined ? { ledger: args.ledger } : {}),
    ...(args.amountOutActual !== undefined ? { amountOutActual: args.amountOutActual } : {}),
  });
}
