/**
 * FixtureSorobanRpc - a TEST ADAPTER for `SorobanRpcPort`. It does NOT run the contract: "simulation"
 * returns a fixed, well-formed SorobanTransactionData and the transaction is assembled with the real
 * `rpc.assembleTransaction` from @stellar/stellar-sdk. Contract refusals are emulated by
 * `failures`, and `get_return` answers come from `returns` (seeded with golden XDR produced by the
 * Rust contract tests). Contract semantics are tested in contracts/redemption-escrow.
 */
import { Address, SorobanDataBuilder, rpc, xdr, type Transaction } from '@stellar/stellar-sdk';
import { TESTNET_PASSPHRASE } from '../types/index.js';
import type { SorobanRpcPort } from '../soroban/escrow.js';

export interface FixtureInvocation {
  contractId: string;
  fn: string;
  args: xdr.ScVal[];
}

export function invocationOf(tx: Transaction): FixtureInvocation {
  const op = tx.operations[0];
  if (!op || op.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') throw new Error('not a Soroban invocation');
  const ic = op.func.invokeContract;
  return { contractId: Address.fromScAddress(ic.contractAddress).toString(), fn: ic.functionName.toString(), args: ic.args };
}

export class FixtureSorobanRpc implements SorobanRpcPort {
  networkPassphrase: string = TESTNET_PASSPHRASE;
  readonly sequences = new Map<string, string>();
  /** redemption key hex -> ScVal returned by get_return */
  readonly returns = new Map<string, xdr.ScVal>();
  /** contract function -> simulation error message (emulates a contract refusal) */
  readonly failures = new Map<string, string>();
  readonly prepared: FixtureInvocation[] = [];
  resourceFee = 123_456;

  async loadSequence(account: string): Promise<string | null> {
    return this.sequences.get(account) ?? null;
  }

  async prepare(tx: Transaction): Promise<Transaction> {
    const inv = invocationOf(tx);
    const failure = this.failures.get(inv.fn);
    if (failure) throw new Error(`HostError: Error(Contract, #${failure})`);
    this.prepared.push(inv);
    const sim: rpc.Api.RawSimulateTransactionResponse = {
      id: 'fixture',
      latestLedger: 1,
      minResourceFee: String(this.resourceFee),
      transactionData: new SorobanDataBuilder().setResourceFee(this.resourceFee).build().toXdr('base64'),
      results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXdr('base64') }],
    };
    return rpc.assembleTransaction(tx, sim).build();
  }

  async simulateRead(tx: Transaction): Promise<xdr.ScVal> {
    const inv = invocationOf(tx);
    if (inv.fn !== 'get_return') throw new Error(`fixture cannot read ${inv.fn}`);
    const arg = inv.args[0];
    if (arg?.type !== 'scvBytes') throw new Error('get_return takes a 32-byte key');
    const key = Buffer.from(arg.bytes.toBytes()).toString('hex');
    return this.returns.get(key) ?? xdr.ScVal.scvVoid();
  }
}
