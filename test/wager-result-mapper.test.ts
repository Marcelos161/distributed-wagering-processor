import { expect, test } from 'bun:test';
import { WagerResultMapper, type WagerResultRecord } from '../src/infrastructure/persistence/financial/wager-result-mapper.js';

test('wager result mapper refuses incompatible versions shapes and monetary values from persistence', () => {
  const row: WagerResultRecord = { transaction_id: 'bet', schema_version: 1, wallet_version: '2',
    response: { transactionId: 'bet', status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } } };
  expect(WagerResultMapper.toSnapshot(row)).toEqual(row.response);
  for (const invalid of [{ ...row, schema_version: 2 }, { ...row, wallet_version: '9007199254740992' },
    { ...row, transaction_id: 'other' }, { ...row, response: null },
    { ...row, response: { transactionId: 'bet', status: 'PENDING', balance: { amount: '75.00', currency: 'BRL' } } },
    { ...row, response: { transactionId: 'bet', status: 'PROCESSED', balance: { amount: 75, currency: 'BRL' } } },
    { ...row, response: { transactionId: 'bet', status: 'PROCESSED', balance: { amount: '075.00', currency: 'BRL' } } },
    { ...row, response: { transactionId: 'bet', status: 'REJECTED', balance: { amount: '0.00', currency: 'BRL' } } }]) {
    expect(() => WagerResultMapper.toSnapshot(invalid)).toThrow();
  }
});
