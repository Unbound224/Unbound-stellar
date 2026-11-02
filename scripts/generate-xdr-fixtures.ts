import { writeFileSync } from 'node:fs';
import { generateXdrFixtures } from './xdr-fixtures.js';

writeFileSync(new URL('../fixtures/xdr/transactions.v1.json', import.meta.url), JSON.stringify(await generateXdrFixtures(), null, 2) + '\n');
