/** A creation conflict, never an idempotent replay. SQL details stay in the cause. */
export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor(options?: ErrorOptions) {
    super('A wallet already exists for this player and currency', options);
    this.name = 'WalletAlreadyExistsError';
  }
}
