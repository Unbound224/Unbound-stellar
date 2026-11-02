export type ErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_ASSET'
  | 'INVALID_SLIPPAGE'
  | 'UNKNOWN_NETWORK'
  | 'UNTRUSTED_ISSUER'
  | 'ISSUER_ACCOUNT_MISSING'
  | 'ACCOUNT_MISSING'
  | 'NO_TRUSTLINE'
  | 'TRUSTLINE_UNAUTHORIZED'
  | 'TRUSTLINE_LIMIT_EXCEEDED'
  | 'INSUFFICIENT_BALANCE'
  | 'NO_ROUTE'
  | 'MIN_OUTPUT_VIOLATION'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_TAMPERED'
  | 'SIGNER_MISMATCH'
  | 'MAINNET_REFUSED';

/** Typed, fail-closed error. Messages are safe to show to clients (no secrets). */
export class UnboundStellarError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'UnboundStellarError';
    this.code = code;
  }
}

/** Thrown by a Submitter when the outcome of a submission is unknown (timeout, connection loss). */
export class SubmitTimeoutError extends Error {
  constructor(message = 'submission outcome unknown') {
    super(message);
    this.name = 'SubmitTimeoutError';
  }
}
