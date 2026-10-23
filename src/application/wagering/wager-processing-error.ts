export type WagerProcessingErrorCode = 'IDEMPOTENCY_CONFLICT' | 'EXTERNAL_TRANSACTION_CONFLICT'
  | 'WALLET_NOT_FOUND' | 'WALLET_PLAYER_MISMATCH' | 'WALLET_CURRENCY_MISMATCH' | 'ORIGINAL_RESULT_UNAVAILABLE';
export class WagerProcessingError extends Error {
  constructor(readonly code: WagerProcessingErrorCode, message: string) { super(message); this.name = 'WagerProcessingError'; }
}
