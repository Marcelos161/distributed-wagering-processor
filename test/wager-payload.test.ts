import { expect, test } from 'bun:test';
import { prepareWager, type WagerInput } from '../src/application/wagering/prepare-wager.js';
import { prepareBet } from '../src/application/wagering/prepare-bet.js';

const input: WagerInput = { providerId: 'provider-a', externalTransactionId: 'win-1', idempotencyKey: 'key',
  playerId: 'player', walletId: 'wallet', roundId: 'round', gameId: 'game', kind: 'WIN', money: { amount: '40.50', currency: 'BRL' } };

test('generic canonicalizer preserves BET bytes and hash', () => {
  const bet = { ...input, kind: 'BET' as const };
  expect(prepareWager(bet)).toEqual(prepareBet(bet));
});
test('WIN reference is canonical, optional, immutable and hash-relevant', () => {
  const plain = prepareWager(input);
  const referenced = prepareWager({ ...input, referenceExternalTransactionId: 'bet' });
  expect(referenced.payloadHash).not.toBe(plain.payloadHash);
  expect(referenced.payloadHash).not.toBe(prepareWager({ ...input, referenceExternalTransactionId: 'other' }).payloadHash);
  expect(referenced.canonicalPayload).toContain('"providerId":"provider-a","referenceExternalTransactionId":"bet","roundId"');
  expect(prepareWager({ referenceExternalTransactionId: 'bet', ...input, idempotencyKey: 'new' }).payloadHash).toBe(referenced.payloadHash);
  expect(Object.isFrozen(referenced.input)).toBe(true);
  expect(plain.payloadHash).toBe(prepareWager({ ...input, referenceExternalTransactionId: undefined } as unknown as WagerInput).payloadHash);
});
test.each(['', 'has space', 'win-1', null, 1])('invalid WIN reference %j fails admission', reference => {
  expect(() => prepareWager({ ...input, referenceExternalTransactionId: reference } as WagerInput)).toThrow();
});
test.each(['0.00', '-1.00', '1.001', '1000000000000000000.00'])('WIN rejects amount %s', amount => {
  expect(() => prepareWager({ ...input, money: { amount, currency: 'BRL' } })).toThrow();
});
test('LOSS requires exactly zero and forbids references', () => {
  const loss = { ...input, kind: 'LOSS' as const, money: { amount: '0.00', currency: 'BRL' } };
  expect(prepareWager(loss).money.isZero()).toBe(true);
  for (const amount of ['1.00', '-1.00']) expect(() => prepareWager({ ...loss, money: { amount, currency: 'BRL' } })).toThrow();
  expect(() => prepareWager({ ...loss, referenceExternalTransactionId: 'bet' })).toThrow();
  expect(() => prepareWager({ ...loss, kind: 'REFUND' } as unknown as WagerInput)).toThrow();
});
test('kind participates in the hash even with otherwise identical positive business fields', () => {
  expect(prepareWager(input).payloadHash).not.toBe(prepareWager({ ...input, kind: 'BET' }).payloadHash);
});
