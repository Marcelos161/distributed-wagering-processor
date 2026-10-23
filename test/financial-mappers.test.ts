import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money/money.js';
import { MoneyMapper, readVersion, writeVersion } from '../src/infrastructure/persistence/financial/money-mapper.js';
import { WalletMapper, type WalletRecord } from '../src/infrastructure/persistence/financial/wallet-mapper.js';
import { WagerTransactionMapper, type WagerTransactionRecord } from '../src/infrastructure/persistence/financial/wager-transaction-mapper.js';
import { LedgerEntryMapper } from '../src/infrastructure/persistence/financial/ledger-entry-mapper.js';

const at = new Date('2026-10-23T12:34:56.789Z');
const walletRow: WalletRecord = { id: 'wallet', player_id: 'player', currency: 'BRL',
  balance: '999999999999999999.99', version: '9007199254740991', created_at: at, updated_at: at };
const transactionRow: WagerTransactionRecord = { id: 'win', provider_id: 'provider',
  external_transaction_id: 'external-win', idempotency_key: 'key', payload_hash: 'hash',
  wallet_id: 'wallet', player_id: 'player', round_id: 'round', game_id: 'game', kind: 'WIN',
  amount: '0.10', currency: 'BRL', status: 'PROCESSED', reference_external_transaction_id: 'external-bet',
  reference_transaction_id: 'bet', failure_code: null, created_at: at, processed_at: at };

describe('financial mappers', () => {
  test.each(['0', '0.1', '0.10', '0000.10', '999999999999999999.99'])('normalizes %s without rounding', (amount) => {
    const money = MoneyMapper.toDomain(amount, 'BRL');
    const expected = amount === '0' ? '0.00' : amount.includes('999') ? amount : '0.10';
    expect(MoneyMapper.toRecord(money)).toBe(expected);
  });
  test.each(['-0.01', '1.005', '1.000', '1e2', 'NaN', 'Infinity', ' 1', '1.', '1000000000000000000.00'])('rejects incompatible amount %s', (amount) => {
    expect(() => MoneyMapper.toDomain(amount, 'BRL')).toThrow();
  });
  test('rejects numeric input and negative internal Money without weakening Money', () => {
    expect(() => MoneyMapper.toDomain(0.1 as unknown as string, 'BRL')).toThrow();
    expect(() => MoneyMapper.toRecord(Money.from({ amount: '0.01', currency: 'BRL' }).negate())).toThrow();
    expect(() => MoneyMapper.toRecord(Money.from({ amount: '1000000000000000000.00', currency: 'BRL' }))).toThrow();
  });
  test.each(['0', '-1', '1.0', '9007199254740992'])('rejects invalid version %s', (version) => {
    expect(() => readVersion(version)).toThrow();
  });
  test('validates output counter and preserves maximum safe version', () => {
    expect(writeVersion(readVersion('9007199254740991'))).toBe('9007199254740991');
    expect(() => writeVersion(1.5)).toThrow();
  });
  test('wallet roundtrip preserves all state with defensive dates', () => {
    const wallet = WalletMapper.toDomain(walletRow);
    const output = WalletMapper.toRecord(wallet);
    expect(output).toEqual(walletRow);
    (output.created_at as Date).setTime(0);
    expect(wallet.createdAt).toEqual(at);
    expect(wallet.version).toBe(Number.MAX_SAFE_INTEGER);
  });
  test('processed reference is reconstructed without resolving or replaying it', () => {
    expect(WagerTransactionMapper.toRecord(WagerTransactionMapper.toDomain(transactionRow))).toEqual(transactionRow);
  });
  test.each([
    ['PENDING', null], ['PENDING_REFERENCE', null], ['REJECTED', 'INVALID_REFERENCE'],
    ['FAILED', 'PERMANENT_INFRASTRUCTURE_FAILURE'],
  ] as const)('preserves lifecycle %s and null fields', (status, failure) => {
    const row = { ...transactionRow, status, failure_code: failure, processed_at: null, reference_transaction_id: null };
    expect(WagerTransactionMapper.toRecord(WagerTransactionMapper.toDomain(row))).toEqual(row);
  });
  test('null external reference remains absent, invalid lifecycle is refused', () => {
    const row = { ...transactionRow, reference_external_transaction_id: null, reference_transaction_id: null };
    expect(WagerTransactionMapper.toDomain(row).referenceExternalTransactionId).toBeUndefined();
    expect(() => WagerTransactionMapper.toDomain({ ...row, status: 'UNKNOWN' })).toThrow();
  });
  test('ledger keeps version separately, rehydrates without recalculating transition', () => {
    const row = { id: 'entry', wallet_id: 'wallet', transaction_id: 'win', wallet_version: '2',
      direction: 'CREDIT', amount: '0.10', currency: 'BRL', balance_before: '0.20', balance_after: '0.30', created_at: at };
    const mapped = LedgerEntryMapper.toDomain(row);
    expect(LedgerEntryMapper.toRecord(mapped.entry, mapped.walletVersion)).toEqual(row);
    expect(mapped.entry.isBalanced()).toBe(true);
    // Deliberately malformed snapshot: arithmetic belongs to create / SQL constraints, not rehydrate.
    expect(LedgerEntryMapper.toDomain({ ...row, balance_after: '0.40' }).entry.isBalanced()).toBe(false);
    expect(Object.isFrozen(mapped)).toBe(true);
  });
});


test('timestamp mapping requires timezone and retains milliseconds', async () => {
  const { readTimestamp } = await import('../src/infrastructure/persistence/financial/timestamp-mapper.js');
  expect(readTimestamp('2026-10-23 09:34:56.789-03').toISOString()).toBe(at.toISOString());
  expect(() => readTimestamp('2026-10-23T12:34:56')).toThrow();
  expect(() => readTimestamp('infinity')).toThrow();
  expect(() => readTimestamp(new Date(NaN))).toThrow();
});
