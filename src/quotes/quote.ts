import { createHash } from 'node:crypto';
import { formatAmount, parseAmount } from '../amount.js';
import { UnboundStellarError } from '../errors.js';
import { assertTestnet, DEFAULT_BASE_FEE } from '../ledger/tx.js';
import type { PathCandidate, PathSource } from '../ports.js';
import type { TrustedAssetRegistry } from '../registry.js';
import { assetKey, sameAsset, type AssetRef, NETWORK_NAME } from '../types/index.js';

export const QUOTE_SCHEMA_VERSION = '1.0';
export const MAX_SLIPPAGE_BPS = 1000; // 10% hard ceiling, regardless of caller request
export const MAX_QUOTE_TTL_MS = 120_000;

export interface QuoteRequest {
  sourceAsset: AssetRef;
  targetAsset: AssetRef;
  /** decimal string, 7 dp */
  sourceAmount: string;
  slippageBps: number;
  /** optional caller floor; if the best route is below it, no quote is produced */
  minimumDestinationAmount?: string;
}

/** Time-bounded INDICATIVE quote. Not a guarantee of execution. */
export interface Quote {
  schemaVersion: typeof QUOTE_SCHEMA_VERSION;
  quoteId: string;
  network: typeof NETWORK_NAME;
  networkPassphrase: string;
  sourceAsset: AssetRef;
  targetAsset: AssetRef;
  sourceAmount: string;
  expectedDestinationAmount: string;
  minDestinationAmount: string;
  slippageBps: number;
  path: AssetRef[];
  /** network fee in stroops for the settlement tx at the base fee */
  estimatedFeeStroops: number;
  /** number of distinct viable routes seen; a thin-liquidity signal, not depth in value */
  routesConsidered: number;
  issuedAt: string;
  expiresAt: string;
  warnings: string[];
}

export interface QuoteDeps {
  pathSource: PathSource;
  registry: TrustedAssetRegistry;
  now?: () => number;
  ttlMs?: number;
}

export async function quoteStrictSend(deps: QuoteDeps, req: QuoteRequest): Promise<Quote> {
  assertTestnet(deps.pathSource.networkPassphrase);
  deps.registry.assertTrusted(req.sourceAsset);
  deps.registry.assertTrusted(req.targetAsset);
  if (sameAsset(req.sourceAsset, req.targetAsset)) {
    throw new UnboundStellarError('INVALID_ASSET', 'source and target assets must differ');
  }
  if (!Number.isInteger(req.slippageBps) || req.slippageBps < 0 || req.slippageBps > MAX_SLIPPAGE_BPS) {
    throw new UnboundStellarError('INVALID_SLIPPAGE', `slippageBps must be an integer 0..${MAX_SLIPPAGE_BPS}`);
  }
  const sourceUnits = parseAmount(req.sourceAmount);
  const floor = req.minimumDestinationAmount !== undefined ? parseAmount(req.minimumDestinationAmount) : 0n;
  const ttl = Math.min(deps.ttlMs ?? 60_000, MAX_QUOTE_TTL_MS);
  const now = (deps.now ?? Date.now)();

  const raw = await deps.pathSource.findStrictSendPaths(req.sourceAsset, sourceUnits, req.targetAsset);
  // Unapproved routes: every intermediate hop must itself be a verified asset.
  const viable = raw.filter((c) => c.destinationAmount > 0n && c.path.every((p) => deps.registry.isTrusted(p)));
  if (viable.length === 0) {
    throw new UnboundStellarError('NO_ROUTE', 'no approved liquidity route exists for this pair and amount');
  }
  const best = pickBest(viable);
  const minDest = (best.destinationAmount * BigInt(10_000 - req.slippageBps)) / 10_000n;
  if (best.destinationAmount < floor) {
    throw new UnboundStellarError('MIN_OUTPUT_VIOLATION', 'best available output is below the requested minimum');
  }
  const effectiveMin = minDest < floor ? floor : minDest;

  const warnings = [
    'Indicative quote only; liquidity can change before settlement.',
    `Source credit issuer: ${req.sourceAsset.issuer ?? 'native'}. Target issuer: ${req.targetAsset.issuer ?? 'native'}.`,
  ];
  if (viable.length === 1) warnings.push('Only one route found; liquidity is thin.');

  const body = {
    sourceAsset: req.sourceAsset,
    targetAsset: req.targetAsset,
    sourceAmount: formatAmount(sourceUnits),
    expectedDestinationAmount: formatAmount(best.destinationAmount),
    minDestinationAmount: formatAmount(effectiveMin),
    slippageBps: req.slippageBps,
    path: best.path,
    expiresAt: new Date(now + ttl).toISOString(),
  };
  return {
    schemaVersion: QUOTE_SCHEMA_VERSION,
    quoteId: quoteDigest(body),
    network: NETWORK_NAME,
    networkPassphrase: deps.pathSource.networkPassphrase,
    ...body,
    estimatedFeeStroops: DEFAULT_BASE_FEE,
    routesConsidered: viable.length,
    issuedAt: new Date(now).toISOString(),
    warnings,
  };
}

function pickBest(cs: PathCandidate[]): PathCandidate {
  return [...cs].sort((a, b) =>
    a.destinationAmount === b.destinationAmount
      ? a.path.length - b.path.length
      : a.destinationAmount > b.destinationAmount ? -1 : 1,
  )[0]!;
}

type DigestBody = Pick<
  Quote,
  | 'sourceAsset'
  | 'targetAsset'
  | 'sourceAmount'
  | 'expectedDestinationAmount'
  | 'minDestinationAmount'
  | 'slippageBps'
  | 'path'
  | 'expiresAt'
>;

/** Content-addressed id: any edit to a quote's economic fields changes its id. */
export function quoteDigest(q: DigestBody): string {
  const canon = [
    assetKey(q.sourceAsset),
    assetKey(q.targetAsset),
    q.sourceAmount,
    q.expectedDestinationAmount,
    q.minDestinationAmount,
    String(q.slippageBps),
    q.path.map(assetKey).join('>'),
    q.expiresAt,
  ].join('|');
  return 'q_' + createHash('sha256').update(canon).digest('hex').slice(0, 32);
}

export function assertQuoteIntegrity(q: Quote): void {
  if (quoteDigest(q) !== q.quoteId) throw new UnboundStellarError('QUOTE_TAMPERED', 'quote fields do not match quote id');
}

export function assertQuoteFresh(q: Quote, nowMs: number): void {
  if (nowMs >= Date.parse(q.expiresAt)) {
    throw new UnboundStellarError('QUOTE_EXPIRED', 'quote expired; request a new quote and new user approval');
  }
}
