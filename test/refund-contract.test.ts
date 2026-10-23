import { expect, test } from 'bun:test';
import { prepareWager, type WagerInput } from '../src/application/wagering/prepare-wager.js';
import { Money } from '../src/domain/money/money.js';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../src/domain/wagering/wager-transaction.js';
import { FailureCode } from '../src/domain/wagering/failure-code.js';

const input: WagerInput = { providerId: 'provider', externalTransactionId: 'refund', idempotencyKey: 'refund',
  playerId: 'player', walletId: 'wallet', roundId: 'round', gameId: 'game', kind: 'REFUND',
  money: { amount: '25.00', currency: 'BRL' }, referenceExternalTransactionId: 'bet' };
const at = new Date('2026-10-23T16:00:00Z');
function transaction(kind: WagerTransactionKind, id: string, reference?: string, amount = '25.00'): WagerTransaction {
  return WagerTransaction.create({ ...input, id, externalTransactionId: id, idempotencyKey: id, kind,
    money: Money.from({ amount, currency: 'BRL' }), payloadHash: 'hash', createdAt: at,
    referenceExternalTransactionId: reference } as Parameters<typeof WagerTransaction.create>[0]);
}

test('REFUND canonical hash includes reference, normalizes money and excludes delivery key', () => {
  const prepared = prepareWager(input);
  expect(prepared.payloadHash).toBe(prepareWager({ ...input, idempotencyKey: 'another', money: { amount: '00025.00', currency: 'BRL' } }).payloadHash);
  expect(prepared.payloadHash).not.toBe(prepareWager({ ...input, referenceExternalTransactionId: 'other' }).payloadHash);
  expect(prepared.payloadHash).not.toBe(prepareWager({ ...input, kind: 'WIN' }).payloadHash);
  expect(Object.isFrozen(prepared.input.money)).toBe(true);
});
test.each([undefined, null, '', 'bad ref', 'refund'])('REFUND rejects missing or invalid reference %j', reference => {
  expect(() => prepareWager({ ...input, referenceExternalTransactionId: reference } as WagerInput)).toThrow();
});
test.each(['0.00', '-1.00', '1.005', '1000000000000000000.00'])('REFUND rejects inadmissible amount %s', amount => {
  expect(() => prepareWager({ ...input, money: { amount, currency: 'BRL' } })).toThrow();
});
test('refund availability accepts a processed full BET and rejects a previous processed refund without mutating state', () => {
  const bet = transaction(WagerTransactionKind.Bet, 'bet'); bet.markProcessed(undefined, at);
  const refund = transaction(WagerTransactionKind.Refund, 'refund', 'bet');
  expect(() => refund.assertRefundAvailable(bet, null)).not.toThrow();
  const previous = transaction(WagerTransactionKind.Refund, 'previous', 'bet'); previous.markProcessed(bet, at);
  expect(() => refund.assertRefundAvailable(bet, previous)).toThrow(expect.objectContaining({ code: 'DUPLICATE_REVERSAL' }));
  expect(refund.status).toBe(WagerTransactionStatus.Pending);
  refund.reject(FailureCode.DuplicateReversal);
  expect(() => refund.assertRefundAvailable(bet, null)).toThrow(expect.objectContaining({ code: 'INVALID_TRANSACTION_STATE' }));
});
test('refund availability delegates reference status, amount and identity validation to the existing domain', () => {
  const pending = transaction(WagerTransactionKind.Bet, 'bet');
  const refund = transaction(WagerTransactionKind.Refund, 'refund', 'bet');
  expect(() => refund.assertRefundAvailable(undefined, null)).toThrow(expect.objectContaining({ code: 'REFERENCE_REQUIRED' }));
  expect(() => refund.assertRefundAvailable(pending, null)).toThrow(expect.objectContaining({ code: 'REFERENCE_NOT_PROCESSED' }));
  pending.markProcessed(undefined, at);
  expect(() => transaction(WagerTransactionKind.Refund, 'partial', 'bet', '10.00').assertRefundAvailable(pending, null))
    .toThrow(expect.objectContaining({ code: 'INVALID_REFERENCE' }));
  const win = transaction(WagerTransactionKind.Win, 'win');
  expect(() => win.assertRefundAvailable(pending, null)).toThrow(expect.objectContaining({ code: 'INVALID_KIND' }));
  const wrongEvidence = transaction(WagerTransactionKind.Refund, 'previous', 'bet');
  expect(() => refund.assertRefundAvailable(pending, wrongEvidence)).toThrow(TypeError);
});

const legacyHashes = [
  ['BET', false, '25.00', 'b5d5302c08f9e217563717125da47d2a024f1dcba489f07d988c9cdc4fd8630a'],
  ['WIN', false, '25.00', '16dd82ea69e2132ca240aae3e526dc05e851f3882a2a7d6001a5da68a5ca58e3'],
  ['WIN', true, '25.00', 'f3e99130e2c45909b9f60502ae1401da429b8174498c4d0c70ff49a3d1551f2f'],
  ['LOSS', false, '0.00', 'dcaca6890940d35a905d72b87a388229c45476d6e94879154b8d8daf0a0fddc9'],
] as const;
test.each(legacyHashes)('%s hash with reference=%s retains the previous canonical bytes', (kind, withReference, amount, expected) => {
  const { referenceExternalTransactionId: _, ...withoutReference } = input;
  expect(prepareWager({ ...withoutReference, kind, money: { amount, currency: 'BRL' },
    ...(withReference ? { referenceExternalTransactionId: 'bet' } : {}) }).payloadHash).toBe(expected);
});
