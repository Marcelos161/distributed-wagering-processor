export type WalletErrorCode =
  | 'INVALID_STATE'
  | 'INVALID_IDENTIFIER'
  | 'INVALID_MONEY'
  | 'NEGATIVE_BALANCE'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_DATE'
  | 'INVALID_VERSION'
  | 'VERSION_EXHAUSTED'
  | 'NON_POSITIVE_MOVEMENT'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_OPENING_CONTEXT';

export class WalletError extends Error {
  constructor(public readonly code: WalletErrorCode, message: string) {
    super(message);
    this.name = 'WalletError';
  }
}
