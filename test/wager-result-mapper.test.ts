import { FailureCode } from '../src/domain/wagering/failure-code.js';
import { expect, test } from 'bun:test';
import { WagerResultMapper, type WagerResultRecord } from '../src/infrastructure/persistence/financial/wager-result-mapper.js';
import { WagerTransactionStatus } from '../src/domain/wagering/wager-transaction.js';

test('wager result mapper refuses incompatible versions shapes and monetary values from persistence', () => {
  const row: WagerResultRecord = { transaction_id: 'bet', schema_version: 1, wallet_version: '2',
    response: { transactionId: 'bet', status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } } };
  expect(WagerResultMapper.toSnapshot(row)).toEqual({ transactionId: 'bet', status: WagerTransactionStatus.Processed,
    balance: { amount: '75.00', currency: 'BRL' } });
  for (const invalid of [{ ...row, schema_version: 2 }, { ...row, wallet_version: '9007199254740992' },
    { ...row, transaction_id: 'other' }, { ...row, response: null },
    { ...row, response: { transactionId: 'bet', status: 'PENDING', balance: { amount: '75.00', currency: 'BRL' } } },
    { ...row, response: { transactionId: 'bet', status: 'PROCESSED', balance: { amount: 75, currency: 'BRL' } } },
    { ...row, response: { transactionId: 'bet', status: 'PROCESSED', balance: { amount: '075.00', currency: 'BRL' } } },
    { ...row, response: { transactionId: 'bet', status: 'REJECTED', balance: { amount: '0.00', currency: 'BRL' } } }]) {
    expect(() => WagerResultMapper.toSnapshot(invalid)).toThrow();
  }
});

test('pending receipts use the same strict money/version validation but cannot masquerade as terminal results', () => {
  const row: WagerResultRecord = { transaction_id: 'win', schema_version: 1, wallet_version: '1',
    response: { transactionId: 'win', status: 'PENDING_REFERENCE', balance: { amount: '75.00', currency: 'BRL' } } };
  const receipt = WagerResultMapper.toPendingReceipt(row);
  expect(receipt.status).toBe(WagerTransactionStatus.PendingReference); expect(Object.isFrozen(receipt.balance)).toBe(true);
  expect(WagerResultMapper.toRecord(receipt, 1)).toEqual(row);
  expect(() => WagerResultMapper.toSnapshot(row)).toThrow();
  expect(() => WagerResultMapper.toPendingReceipt({ ...row, response: { ...receipt, status: 'PROCESSED' } })).toThrow();
  expect(() => WagerResultMapper.toPendingReceipt({ ...row, response: { ...receipt, failureCode: 'INVALID_REFERENCE' } })).toThrow();
});
test('WIN reference rejection remains a terminal historical result', () => {
  const row: WagerResultRecord = { transaction_id: 'win', schema_version: 1, wallet_version: '1',
    response: { transactionId: 'win', status: 'REJECTED', failureCode: 'INVALID_REFERENCE', balance: { amount: '75.00', currency: 'BRL' } } };
  expect(WagerResultMapper.toSnapshot(row)).toEqual({ transactionId: 'win', status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InvalidReference, balance: { amount: '75.00', currency: 'BRL' } });
});
