/** The SQL attempt has been rolled back; a whole new transaction may be attempted. */
export class RetryableFinancialTransactionError extends Error {
  constructor(readonly sqlState: '40001' | '40P01', options: ErrorOptions) {
    super('Financial transaction must be retried from fresh state', options);
    this.name = 'RetryableFinancialTransactionError';
  }
}
