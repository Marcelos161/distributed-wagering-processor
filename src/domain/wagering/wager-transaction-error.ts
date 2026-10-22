export type WagerTransactionErrorCode =
  | 'INVALID_STATE' | 'INVALID_IDENTIFIER' | 'INVALID_KIND' | 'INTERNAL_ONLY_KIND'
  | 'INVALID_MONEY' | 'INVALID_AMOUNT' | 'INVALID_DATE' | 'INVALID_REFERENCE'
  | 'REFERENCE_REQUIRED' | 'REFERENCE_NOT_PROCESSED' | 'INVALID_FAILURE_CODE'
  | 'INVALID_TRANSACTION_STATE';

export class WagerTransactionError extends Error {
  constructor(public readonly code: WagerTransactionErrorCode, message: string) {
    super(message);
    this.name = 'WagerTransactionError';
  }
}

export class InvalidTransactionStateError extends WagerTransactionError {
  constructor(message: string) {
    super('INVALID_TRANSACTION_STATE', message);
    this.name = 'InvalidTransactionStateError';
  }
}
