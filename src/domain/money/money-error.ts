export type MoneyErrorCode = 'INVALID_AMOUNT' | 'UNSUPPORTED_CURRENCY' | 'CURRENCY_MISMATCH';

/** Domain failure; transport layers will decide how to present it. */
export class MoneyError extends Error {
  constructor(public readonly code: MoneyErrorCode, message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}
