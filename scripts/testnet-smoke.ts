/**
 * Testnet smoke run for the redemption escrow. Drives REAL transactions through stellar-cli and prints their hashes.
 *
 *   npx tsx scripts/testnet-smoke.ts            # setup + confirm, reject, replay, wrong-signer, and open the expiry return
 *   npx tsx scripts/testnet-smoke.ts finish     # after the 1 hour minimum window: expire_refund, then check the escrow is empty
 *
 * Keys never pass through this script: it only names `stellar keys` aliases, and the keys stay in the local keystore.
 * Testnet only. Public data (contract id, hashes, public addresses) is written to
 * contracts/deployments/testnet-smoke.json; the file is the evidence log.
 *
 * Requires: scripts/deploy-testnet.sh has run, the issuer/distributor aliases exist, and the escrow is authorized
 * for the credit (see docs/DEPLOYMENT.md).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployFile = join(root, 'contracts/deployments/testnet.json');
const outFile = join(root, 'contracts/deployments/testnet-smoke.json');
const NET = ['--network', 'testnet'];
const ISSUER = process.env.ISSUER_ALIAS ?? 'unbound-issuer';
const CONSUMER = process.env.CONSUMER_ALIAS ?? 'unbound-consumer';
const CODE = process.env.ASSET_CODE ?? 'SHOP';
const ONE = 10_000_000n; // 7 decimals
const MIN_WINDOW = 3_600;

type Step = { name: string; redemptionId?: string; expected: string; result: 'ok' | 'refused'; txHash?: string; detail?: string };
type Log = {
  network: 'testnet';
  escrow: string;
  asset: string;
  sac: string;
  issuer: string;
  consumer: string;
  victim?: string;
  startedAt: string;
  steps: Step[];
  expiry?: { redemptionId: string; deadline: number; openedTx: string };
  finishedAt?: string;
};

function cli(args: string[], allowFail = false): { ok: boolean; out: string; stdout: string } {
  // stellar-cli prints the explorer link (with the tx hash) on stderr, so capture both streams on success too.
  // Transient network errors ("client error (Connect)") are retried; contract/auth refusals are not.
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync('stellar', args, { encoding: 'utf8', cwd: tmpdir() }) // not the repo dir: stellar-cli would load its .env (gateway settings);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status === 0) return { ok: true, out, stdout: r.stdout ?? '' };
    if (attempt < 4 && /client error \(Connect\)|timed out|connection (reset|refused)|Too Many Requests/i.test(out)) continue;
    if (!allowFail) throw new Error(`stellar ${args.slice(0, 4).join(' ')} failed:
${out}`);
    return { ok: false, out, stdout: r.stdout ?? '' };
  }
}

// Hashes come from the explorer link stellar-cli prints; the last one is the invoke itself.
const hashOf = (out: string): string | undefined => [...out.matchAll(/\/tx\/([0-9a-f]{64})/g)].at(-1)?.[1];
const addr = (alias: string) => cli(["keys", "address", alias]).stdout.trim();

function invoke(source: string, id: string, fn: string, fnArgs: string[], allowFail = false) {
  return cli(['contract', 'invoke', '--id', id, '--source-account', source, ...NET, '--', fn, ...fnArgs], allowFail);
}

function balance(sac: string, who: string): bigint {
  const out = invoke(ISSUER, sac, 'balance', ['--id', who]).stdout.trim().replace(/"/g, '');
  return BigInt(out.split(/\s+/).at(-1)!);
}

const newId = () => randomBytes(32).toString('hex');
const nowSec = () => Math.floor(Date.now() / 1000);

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function loadDeployment(): { contractId: string } {
  assert(existsSync(deployFile), 'contracts/deployments/testnet.json missing: run scripts/deploy-testnet.sh first');
  return JSON.parse(readFileSync(deployFile, 'utf8')) as { contractId: string };
}

function save(log: Log): void {
  writeFileSync(outFile, JSON.stringify(log, null, 2) + '\n');
}

function record(log: Log, s: Step): void {
  log.steps.push(s);
  save(log);
  console.log(`${s.result === 'ok' ? 'OK     ' : 'REFUSED'} ${s.name}${s.txHash ? ` tx ${s.txHash}` : ''}${s.detail ? ` (${s.detail})` : ''}`);
}

function ensureConsumer(sac: string, issuerAddr: string, consumerAddr: string): void {
  if (!cli(['keys', 'address', CONSUMER], true).ok) cli(['keys', 'generate', '--fund', CONSUMER, ...NET]);
  const asset = `${CODE}:${issuerAddr}`;
  cli(['tx', 'new', 'change-trust', '--source-account', CONSUMER, '--line', asset, ...NET]);
  cli(['tx', 'new', 'set-trustline-flags', '--source-account', ISSUER, '--trustor', consumerAddr, '--asset', asset, '--set-authorize', ...NET]);
  const have = balance(sac, consumerAddr);
  if (have < 100n * ONE) {
    cli(['tx', 'new', 'payment', '--source-account', ISSUER, '--destination', consumerAddr, '--asset', asset, '--amount', String(100n * ONE), ...NET]);
  }
}

function open(escrow: string, sac: string, issuer: string, consumer: string, id: string, amount: bigint, deadline: number, allowFail = false) {
  return invoke(CONSUMER, escrow, 'open_return', [
    '--consumer', consumer, '--issuer', issuer, '--token', sac,
    '--amount', String(amount), '--redemption_id', id, '--deadline', String(deadline),
  ], allowFail);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'run';
  const { contractId: escrow } = loadDeployment();
  const issuer = addr(ISSUER);
  const consumer = (() => {
    if (!cli(['keys', 'address', CONSUMER], true).ok) cli(['keys', 'generate', '--fund', CONSUMER, ...NET]);
    return addr(CONSUMER);
  })();
  const asset = `${CODE}:${issuer}`;
  const sac = cli(['contract', 'id', 'asset', '--asset', asset, ...NET]).stdout.trim();

  if (mode === 'finish') {
    const log = JSON.parse(readFileSync(outFile, 'utf8')) as Log;
    assert(!!log.expiry, 'no pending expiry return in testnet-smoke.json: run the main smoke first');
    const { redemptionId, deadline } = log.expiry!;
    const before = balance(sac, consumer);
    if (nowSec() < deadline) {
      const early = invoke(CONSUMER, escrow, 'expire_refund', ['--redemption_id', redemptionId], true);
      assert(!early.ok, 'expire_refund before the deadline must be refused');
      console.log(`deadline not reached yet (${new Date(deadline * 1000).toISOString()}); early expire_refund was refused as expected. Run again later.`);
      record(log, { name: 'expire_refund before the deadline is refused', expected: 'DeadlineNotReached (#9)', result: 'refused', detail: early.out.match(/Error\(Contract, #\d+\)/)?.[0] });
      return;
    }
    const done = invoke(CONSUMER, escrow, 'expire_refund', ['--redemption_id', redemptionId]);
    const after = balance(sac, consumer);
    assert(after - before === 5n * ONE, `consumer should regain 5 ${CODE}, got ${after - before}`);
    assert(balance(sac, escrow) === 0n, 'escrow balance must return to zero');
    record(log, { name: 'expire_refund after the deadline returns the credit', expected: 'consumer +5, escrow 0', result: 'ok', txHash: hashOf(done.out) });
    log.finishedAt = new Date().toISOString();
    delete log.expiry;
    save(log);
    return;
  }

  const log: Log = { network: 'testnet', escrow, asset, sac, issuer, consumer, startedAt: new Date().toISOString(), steps: [] };
  ensureConsumer(sac, issuer, consumer);
  assert(balance(sac, escrow) === 0n, 'escrow should start empty');
  const deadline = () => nowSec() + MIN_WINDOW + 600;

  // 1. open_return then confirm: the credit goes to the issuer.
  const a = newId();
  let t = open(escrow, sac, issuer, consumer, a, 10n * ONE, deadline());
  record(log, { name: 'open_return (to be confirmed)', redemptionId: a, expected: 'escrow holds 10', result: 'ok', txHash: hashOf(t.out) });
  assert(balance(sac, escrow) === 10n * ONE, 'escrow should hold 10 after open_return');
  t = invoke(ISSUER, escrow, 'confirm', ['--redemption_id', a]);
  assert(balance(sac, escrow) === 0n, 'escrow should be empty after confirm');
  record(log, { name: 'confirm by the issuer', expected: 'escrow 0, credit with issuer', result: 'ok', txHash: hashOf(t.out) });

  // 2. single-use redemption id: replaying a closed id is refused.
  let r = open(escrow, sac, issuer, consumer, a, 10n * ONE, deadline(), true);
  assert(!r.ok, 'replaying a used redemption id must be refused');
  record(log, { name: 'replay of a used redemption id', expected: 'DuplicateRedemption (#6)', result: 'refused', detail: r.out.match(/Error\(Contract, #\d+\)/)?.[0] });

  // 3. open_return then reject: the credit goes back to the consumer.
  const b = newId();
  const beforeB = balance(sac, consumer);
  t = open(escrow, sac, issuer, consumer, b, 7n * ONE, deadline());
  record(log, { name: 'open_return (to be rejected)', redemptionId: b, expected: 'escrow holds 7', result: 'ok', txHash: hashOf(t.out) });
  t = invoke(ISSUER, escrow, 'reject', ['--redemption_id', b]);
  assert(balance(sac, consumer) === beforeB, 'consumer must get the credit back after reject');
  assert(balance(sac, escrow) === 0n, 'escrow should be empty after reject');
  record(log, { name: 'reject by the issuer', expected: 'consumer refunded, escrow 0', result: 'ok', txHash: hashOf(t.out) });

  // 4. wrong signer: the consumer cannot confirm (only the issuer can); a third account cannot open for the consumer.
  const c = newId();
  t = open(escrow, sac, issuer, consumer, c, 3n * ONE, deadline());
  record(log, { name: 'open_return (wrong-signer target)', redemptionId: c, expected: 'escrow holds 3', result: 'ok', txHash: hashOf(t.out) });
  r = invoke(CONSUMER, escrow, 'confirm', ['--redemption_id', c], true);
  assert(!r.ok, 'confirm signed by the consumer must be refused');
  record(log, { name: 'confirm signed by the consumer (not the issuer)', expected: 'auth failure', result: 'refused', detail: 'client-side: ' + r.out.split('\n').find((l) => /Missing signing key|auth/i.test(l))?.trim() });
  // The victim holds credit but its key is NOT in the keystore, so nobody here can sign for it. (stellar-cli signs the
  // auth of any account whose key it holds, so using the consumer for this test would prove nothing.)
  // The victim's key lives in a throwaway config dir that is deleted right after setup, so this script (and the main
  // keystore) can never sign for it.
  const victimDir = mkdtempSync(join(tmpdir(), 'unbound-victim-'));
  const VC = ['--config-dir', victimDir];
  cli(['keys', 'generate', '--fund', 'victim', ...VC, ...NET]);
  const victim = cli(['keys', 'address', 'victim', ...VC]).stdout.trim();
  cli(['tx', 'new', 'change-trust', '--source-account', 'victim', '--line', asset, ...VC, ...NET]);
  cli(['tx', 'new', 'set-trustline-flags', '--source-account', ISSUER, '--trustor', victim, '--asset', asset, '--set-authorize', ...NET]);
  cli(['tx', 'new', 'payment', '--source-account', ISSUER, '--destination', victim, '--asset', asset, '--amount', String(5n * ONE), ...NET]);
  rmSync(victimDir, { recursive: true, force: true });
  log.victim = victim;
  r = invoke(ISSUER, escrow, 'open_return', ['--consumer', victim, '--issuer', issuer, '--token', sac, '--amount', String(ONE), '--redemption_id', newId(), '--deadline', String(deadline())], true);
  assert(!r.ok, 'open_return naming a victim account, signed by someone else, must be refused');
  assert(balance(sac, victim) === 5n * ONE && balance(sac, escrow) === 3n * ONE, 'no credit may move');
  record(log, { name: 'open_return naming a victim account, signed by the issuer', expected: 'refused, victim credit untouched', result: 'refused', detail: 'client-side: ' + (r.out.split('\n').find((l) => /Missing signing key|auth/i.test(l))?.trim() ?? r.out.slice(0, 120)) });
  t = invoke(ISSUER, escrow, 'reject', ['--redemption_id', c]);
  record(log, { name: 'reject (cleanup of the wrong-signer target)', expected: 'escrow back to 0', result: 'ok', txHash: hashOf(t.out) });
  assert(balance(sac, escrow) === 0n, 'escrow should be empty before the expiry case');

  // 5. expire_refund: needs the shortest allowed window (1 hour). Opened now, finished later with `finish`.
  const d = newId();
  const dl = nowSec() + MIN_WINDOW + 120;
  t = open(escrow, sac, issuer, consumer, d, 5n * ONE, dl);
  log.expiry = { redemptionId: d, deadline: dl, openedTx: hashOf(t.out)! };
  record(log, { name: 'open_return (to be refunded by expiry)', redemptionId: d, expected: 'escrow holds 5 until the deadline', result: 'ok', txHash: hashOf(t.out), detail: `deadline ${new Date(dl * 1000).toISOString()}` });
  r = invoke(CONSUMER, escrow, 'expire_refund', ['--redemption_id', d], true);
  assert(!r.ok, 'expire_refund before the deadline must be refused');
  record(log, { name: 'expire_refund before the deadline', expected: 'DeadlineNotReached (#9)', result: 'refused', detail: r.out.match(/Error\(Contract, #\d+\)/)?.[0] });
  assert(balance(sac, escrow) === 5n * ONE, 'escrow keeps 5 until expiry');
  save(log);
  console.log(`\nDone for now. Run again after ${new Date(dl * 1000).toISOString()}:\n  npx tsx scripts/testnet-smoke.ts finish`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
