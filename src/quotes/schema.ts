import { z } from 'zod';
import { QUOTE_SCHEMA_VERSION, type Quote } from './quote.js';

const Asset = z.object({ code: z.string(), issuer: z.string().nullable() }).strict();
const Amount7 = z.string().regex(/^\d+\.\d{7}$/);

/** Runtime validation for a Quote received over the wire (the gateway never trusts a client-supplied quote blindly; integrity is re-checked by id). */
export const QuoteSchema = z
  .object({
    schemaVersion: z.literal(QUOTE_SCHEMA_VERSION),
    quoteId: z.string(),
    network: z.literal('TESTNET'),
    networkPassphrase: z.string(),
    sourceAsset: Asset,
    targetAsset: Asset,
    sourceAmount: Amount7,
    expectedDestinationAmount: Amount7,
    minDestinationAmount: Amount7,
    slippageBps: z.number().int(),
    path: z.array(Asset),
    estimatedFeeStroops: z.number().int(),
    routesConsidered: z.number().int(),
    issuedAt: z.string(),
    expiresAt: z.string(),
    warnings: z.array(z.string()),
  })
  .strict() satisfies z.ZodType<Quote>;
