import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../domain/money/money.js';

export interface BetInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: 'BET';
  readonly money: Readonly<MoneyProps>;
}
export interface PreparedBet {
  readonly input: Readonly<BetInput>;
  readonly money: Money;
  readonly canonicalPayload: string;
  readonly payloadHash: string;
}
export class InvalidWagerInputError extends Error {
  readonly code = 'INVALID_WAGER_INPUT';
  constructor(message: string) { super(message); this.name = 'InvalidWagerInputError'; }
}

/** Canonical BET business contract v1, independent of HTTP headers and broker envelopes. */
export function prepareBet(input: BetInput): PreparedBet {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidWagerInputError('Wager input must be an object');
  for (const field of ['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId'] as const) {
    assertToken(input[field], field);
  }
  if (input.providerId === 'internal:wallet-opening') throw new InvalidWagerInputError('Provider namespace is reserved for internal openings');
  if (input.kind !== 'BET') throw new InvalidWagerInputError('Only BET is supported by this use case');
  if ('referenceExternalTransactionId' in input && input.referenceExternalTransactionId !== undefined) {
    throw new InvalidWagerInputError('BET cannot reference another transaction');
  }
  const money = Money.from(input.money);
  if (!money.isPositive()) throw new InvalidWagerInputError('BET amount must be positive');
  if (Money.from({ amount: '999999999999999999.99', currency: money.currency }).isLessThan(money)) {
    throw new InvalidWagerInputError('BET amount exceeds the financial storage limit');
  }
  // Explicit allowlist in lexicographic order, also inside money. Input property order is irrelevant.
  const business = {
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: 'BET' as const,
    money: Object.freeze(money.toJSON()),
    playerId: input.playerId,
    providerId: input.providerId,
    roundId: input.roundId,
    walletId: input.walletId,
  };
  const canonicalPayload = JSON.stringify(business);
  return Object.freeze({ input: Object.freeze({ ...business, idempotencyKey: input.idempotencyKey }), money,
    canonicalPayload, payloadHash: createHash('sha256').update(canonicalPayload, 'utf8').digest('hex') });
}

function assertToken(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw new InvalidWagerInputError(`${field} must be a non-empty token without whitespace or control characters`);
  }
}
