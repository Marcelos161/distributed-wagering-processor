export type LedgerEntryErrorCode =
  | 'INVALID_STATE'
  | 'INVALID_IDENTIFIER'
  | 'INVALID_DIRECTION'
  | 'INVALID_MONEY'
  | 'INVALID_CREATED_AT'
  | 'NON_POSITIVE_MOVEMENT'
  | 'NEGATIVE_BALANCE'
  | 'CURRENCY_MISMATCH'
  | 'UNBALANCED_ENTRY';

export class LedgerEntryError extends Error {
  constructor(public readonly code: LedgerEntryErrorCode, message: string) {
    super(message);
    this.name = 'LedgerEntryError';
  }
}
