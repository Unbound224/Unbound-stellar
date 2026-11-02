import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ReconciliationEventSchema } from '../src/indexer/event.js';

export function reconciliationEventJsonSchema(): string {
  return JSON.stringify(z.toJSONSchema(ReconciliationEventSchema), null, 2) + '\n';
}

if (process.argv[1]?.endsWith('generate-schemas.ts')) {
  writeFileSync(new URL('../schemas/reconciliation-event.v1.json', import.meta.url), reconciliationEventJsonSchema());
}
