import { Keypair, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { UnboundStellarError } from '../errors.js';
import type { Signer } from '../ports.js';
import { assertTestnet } from '../ledger/tx.js';

/**
 * TEST-ONLY signer holding a secret in memory. Used by tests and the local demo with freshly
 * generated throwaway Testnet keys. Production signing happens on the user's device (see
 * unbound-mobile); this package never needs to see a user's secret.
 */
export class TestnetKeypairSigner implements Signer {
  private readonly kp: Keypair;
  constructor(kp: Keypair = Keypair.random()) {
    this.kp = kp;
  }
  get publicKey(): string {
    return this.kp.publicKey();
  }
  signHash(hash: Uint8Array): Uint8Array {
    return this.kp.sign(hash);
  }
}

/** Adds the signer's signature to an unsigned XDR. Refuses a signer that is not the tx source. */
export function signTransaction(unsignedXdr: string, networkPassphrase: string, signer: Signer): string {
  assertTestnet(networkPassphrase);
  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase) as Transaction;
  if (tx.source !== signer.publicKey) {
    throw new UnboundStellarError('SIGNER_MISMATCH', 'signer is not the transaction source account');
  }
  const kp = Keypair.fromPublicKey(signer.publicKey);
  const sig = signer.signHash(tx.hash());
  if (!kp.verify(tx.hash(), sig)) throw new UnboundStellarError('SIGNER_MISMATCH', 'signer produced an invalid signature');
  tx.addDecoratedSignature(new xdr.DecoratedSignature({ hint: kp.signatureHint(), signature: sig }));
  return tx.toXDR();
}
