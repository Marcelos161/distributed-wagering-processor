import { describe, expect, test } from 'bun:test';
import { prepareBet, type BetInput } from '../src/application/wagering/prepare-bet.js';

const input: BetInput = { providerId: 'provider-a', externalTransactionId: 'bet-1', idempotencyKey: 'key-1',
  playerId: 'player', walletId: 'wallet', roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };

describe('canonical BET payload', () => {
  test('sorts known keys, preserves exact decimal text and matches an independently calculated SHA-256', () => {
    const prepared = prepareBet(input);
    expect(prepared.canonicalPayload).toBe('{"externalTransactionId":"bet-1","gameId":"game","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player","providerId":"provider-a","roundId":"round","walletId":"wallet"}');
    expect(prepared.payloadHash).toBe('3453cc106ee4d196dbb10fd6695becbdd4ef529164a71d899a4b72358b93cba7');
  });
  test('ignores original key ordering, transport metadata and Idempotency-Key', () => {
    const reordered = { money: { currency: 'BRL', amount: '00025.00' }, kind: 'BET' as const,
      gameId: input.gameId, roundId: input.roundId, walletId: input.walletId, playerId: input.playerId,
      externalTransactionId: input.externalTransactionId, providerId: input.providerId, idempotencyKey: 'different-key',
      messageId: 'delivery-2', occurredAt: 'transport-time', correlationId: 'trace-2' };
    expect(prepareBet(reordered).payloadHash).toBe(prepareBet(input).payloadHash);
  });
  test.each(['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId'] as const)(
    'changing %s changes the business hash', field => {
      expect(prepareBet({ ...input, [field]: 'different' }).payloadHash).not.toBe(prepareBet(input).payloadHash);
    });
  test.each([{ amount: '25.01', currency: 'BRL' }, { amount: '25.00', currency: 'USD' }])('changing money %j changes the hash', money => {
    expect(prepareBet({ ...input, money }).payloadHash).not.toBe(prepareBet(input).payloadHash);
  });
  test('captures immutable normalized input without retaining mutable transport objects', () => {
    const source = { ...input, money: { ...input.money } };
    const prepared = prepareBet(source);
    source.playerId = 'changed'; source.money.amount = '90.00';
    expect(prepared.input.playerId).toBe('player'); expect(prepared.money.toJSON().amount).toBe('25.00');
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.input)).toBe(true);
    expect(Object.isFrozen(prepared.input.money)).toBe(true);
  });
  test.each(['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId'] as const)(
    'rejects missing or malformed %s', field => {
      for (const value of ['', 'has space', 'control\u0000', undefined, 42]) {
        expect(() => prepareBet({ ...input, [field]: value } as BetInput)).toThrow();
      }
    });
  test.each(['0.00', '-1.00', '1.001', '1e2', 'NaN', '1000000000000000000.00'])('rejects invalid or inadmissible amount %s', amount => {
    expect(() => prepareBet({ ...input, money: { amount, currency: 'BRL' } })).toThrow();
  });
  test('rejects unsupported currency, numeric money, other kinds, references and the internal provider', () => {
    for (const patch of [{ money: { amount: '1.00', currency: 'JPY' } }, { money: { amount: 1, currency: 'BRL' } },
      { kind: 'WIN' }, { kind: 'OPENING' }, { referenceExternalTransactionId: 'ref' }, { providerId: 'internal:wallet-opening' }]) {
      expect(() => prepareBet({ ...input, ...patch } as BetInput)).toThrow();
    }
    for (const invalid of [null, [], undefined]) expect(() => prepareBet(invalid as unknown as BetInput)).toThrow();
  });
});
