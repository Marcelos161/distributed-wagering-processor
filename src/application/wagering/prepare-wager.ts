import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../domain/money/money.js';

export interface WagerInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: 'BET' | 'WIN' | 'LOSS';
  readonly referenceExternalTransactionId?: string;
  readonly money: Readonly<MoneyProps>;
}
export interface PreparedWager {
  readonly input: Readonly<WagerInput>;
  readonly money: Money;
  readonly canonicalPayload: string;
  readonly payloadHash: string;
}
export class InvalidWagerInputError extends Error {
  readonly code = 'INVALID_WAGER_INPUT';
  constructor(message: string) { super(message); this.name = 'InvalidWagerInputError'; }
}

/** Business contract v1: BET bytes remain unchanged; WIN includes its optional reference. */
export function prepareWager(input: WagerInput): PreparedWager {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidWagerInputError('Wager input must be an object');
  for (const field of ['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId'] as const) {
    assertToken(input[field], field);
  }
  if (input.providerId === 'internal:wallet-opening') throw new InvalidWagerInputError('Provider namespace is reserved for internal openings');
  if (!['BET', 'WIN', 'LOSS'].includes(input.kind)) throw new InvalidWagerInputError('Only BET, WIN and LOSS are supported');
  const reference = input.referenceExternalTransactionId;
  if (reference !== undefined) {
    assertToken(reference, 'referenceExternalTransactionId');
    if (input.kind !== 'WIN' || reference === input.externalTransactionId) {
      throw new InvalidWagerInputError('Only WIN may reference another external transaction');
    }
  }
  const money = Money.from(input.money);
  if (input.kind === 'LOSS' ? !money.isZero() : !money.isPositive()) {
    throw new InvalidWagerInputError('LOSS requires zero; BET and WIN require positive amounts');
  }
  if (Money.from({ amount: '999999999999999999.99', currency: money.currency }).isLessThan(money)) {
    throw new InvalidWagerInputError('Wager amount exceeds the financial storage limit');
  }
  // Explicit allowlist in lexicographic order, also inside money. Input property order is irrelevant.
  const business = {
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: Object.freeze(money.toJSON()),
    playerId: input.playerId,
    providerId: input.providerId,
    ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
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
