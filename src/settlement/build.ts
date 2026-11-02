import { formatAmount, parseAmount } from '../amount.js';
import { UnboundStellarError } from '../errors.js';
import { assertCanReceive } from '../ledger/trustline.js';
import { buildTx, Operation, toSdkAsset, type BuiltTx } from '../ledger/tx.js';
import type { LedgerReader } from '../ports.js';
import { assertQuoteFresh, assertQuoteIntegrity, type Quote } from '../quotes/quote.js';
import type { TrustedAssetRegistry } from '../registry.js';
import { assetKey } from '../types/index.js';

export interface SettlementRequest {
  quote: Quote;
  /** account that signs and sends the source credit */
  sourceAccount: string;
  /** account receiving the target asset (may equal sourceAccount) */
  destinationAccount: string;
  /** stable per-intent key, bound into the tx memo */
  idempotencyKey: string;
  nowMs?: number;
}

/**
 * Builds the UNSIGNED strict-send path payment for a quote the user approved. Everything is
 * re-validated at build time because ledger state may have moved since the quote:
 * integrity, freshness, trusted assets, sender balance, destination trustline/authorization.
 * The tx expires no later than the quote, so a stale approval cannot be signed-and-held.
 */
export async function buildSettlementTx(
  reader: LedgerReader,
  registry: TrustedAssetRegistry,
  req: SettlementRequest,
): Promise<BuiltTx> {
  const { quote } = req;
  if (quote.networkPassphrase !== reader.networkPassphrase) {
    throw new UnboundStellarError('UNKNOWN_NETWORK', 'quote and ledger reader are on different networks');
  }
  assertQuoteIntegrity(quote);
  const now = req.nowMs ?? Date.now();
  assertQuoteFresh(quote, now);
  registry.assertTrusted(quote.sourceAsset);
  registry.assertTrusted(quote.targetAsset);
  for (const p of quote.path) registry.assertTrusted(p);

  const sendAmount = parseAmount(quote.sourceAmount);
  const destMin = parseAmount(quote.minDestinationAmount);

  const sender = await reader.loadAccount(req.sourceAccount);
  if (!sender) throw new UnboundStellarError('ACCOUNT_MISSING', 'source account does not exist');
  const held = quote.sourceAsset.issuer === null
    ? sender.balances.find((b) => b.asset.issuer === null)
    : sender.balances.find((b) => assetKey(b.asset) === assetKey(quote.sourceAsset));
  if (!held) throw new UnboundStellarError('NO_TRUSTLINE', 'source account holds none of the source asset');
  if (!held.isAuthorized) throw new UnboundStellarError('TRUSTLINE_UNAUTHORIZED', 'source trustline is not authorized');
  if (held.balance < sendAmount) throw new UnboundStellarError('INSUFFICIENT_BALANCE', 'source balance is below the sell amount');

  await assertCanReceive(reader, req.destinationAccount, quote.targetAsset, destMin);

  return buildTx({
    sourceId: req.sourceAccount,
    sequence: sender.sequence,
    networkPassphrase: reader.networkPassphrase,
    maxTime: Math.floor(Date.parse(quote.expiresAt) / 1000),
    idempotencyKey: req.idempotencyKey,
    operations: [
      Operation.pathPaymentStrictSend({
        sendAsset: toSdkAsset(quote.sourceAsset),
        sendAmount: formatAmount(sendAmount),
        destination: req.destinationAccount,
        destAsset: toSdkAsset(quote.targetAsset),
        destMin: formatAmount(destMin),
        path: quote.path.map(toSdkAsset),
      }),
    ],
  });
}
