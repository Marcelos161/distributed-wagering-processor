import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Money } from '../src/domain/money/money.js';
import { LedgerEntryError, type LedgerEntryErrorCode } from '../src/domain/wallet/ledger-entry-error.js';
import { LedgerDirection, WalletLedgerEntry, type LedgerEntryState } from '../src/domain/wallet/wallet-ledger-entry.js';

function amount(value: string, currency = 'BRL'): Money {
  return Money.from({ amount: value, currency });
}

function state(overrides: Partial<LedgerEntryState> = {}): LedgerEntryState {
  return {
    id: 'entry-1', walletId: 'wallet-1', transactionId: 'transaction-1',
    direction: LedgerDirection.Debit,
    money: amount('25.00'), balanceBefore: amount('100.00'), balanceAfter: amount('75.00'),
    createdAt: new Date('2026-10-22T12:00:00.000Z'),
    ...overrides,
  };
}

function expectCode(run: () => unknown, code: LedgerEntryErrorCode): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(LedgerEntryError);
  expect(caught).toHaveProperty('name', 'LedgerEntryError');
  expect(caught).toHaveProperty('code', code);
}

test('creates a debit with exact before and after balances and preserves supplied identity and time', () => {
  const input = state();
  const entry = WalletLedgerEntry.create(input);
  expect(entry.id).toBe(input.id);
  expect(entry.walletId).toBe(input.walletId);
  expect(entry.transactionId).toBe(input.transactionId);
  expect(entry.direction).toBe(LedgerDirection.Debit);
  expect(entry.money.equals(amount('25.00'))).toBe(true);
  expect(entry.balanceBefore.equals(amount('100.00'))).toBe(true);
  expect(entry.balanceAfter.equals(amount('75.00'))).toBe(true);
  expect(entry.createdAt.toISOString()).toBe('2026-10-22T12:00:00.000Z');
  expect(entry.isBalanced()).toBe(true);
});

test('creates a credit for a prize without changing the earlier balance', () => {
  const input = state({ direction: LedgerDirection.Credit, money: amount('40.50'),
    balanceBefore: amount('75.00'), balanceAfter: amount('115.50') });
  const entry = WalletLedgerEntry.create(input);
  expect(entry.direction).toBe(LedgerDirection.Credit);
  expect(entry.balanceAfter.toString()).toBe('115.50 BRL');
  expect(input.balanceBefore.toString()).toBe('75.00 BRL');
  expect(entry.isBalanced()).toBe(true);
});

test('accepts an opening credit from zero and a debit that exhausts the balance exactly', () => {
  const opening = WalletLedgerEntry.create(state({ direction: LedgerDirection.Credit,
    balanceBefore: Money.zero('BRL'), balanceAfter: amount('25.00') }));
  const debit = WalletLedgerEntry.create(state({ balanceBefore: amount('25.00'), balanceAfter: Money.zero('BRL') }));
  expect(opening.isBalanced()).toBe(true);
  expect(debit.isBalanced()).toBe(true);
  expect(debit.balanceAfter.isZero()).toBe(true);
});

test.each([LedgerDirection.Debit, LedgerDirection.Credit])
('create rejects incorrect %s arithmetic while rehydrate preserves it for inspection', (direction) => {
  const input = state({ direction, balanceAfter: amount('74.99') });
  expectCode(() => WalletLedgerEntry.create(input), 'UNBALANCED_ENTRY');
  const restored = WalletLedgerEntry.rehydrate(input);
  expect(restored.isBalanced()).toBe(false);
  expect(restored.balanceAfter.toString()).toBe('74.99 BRL');
  expect(Object.isFrozen(restored)).toBe(true);
});

const invalidCases: Array<{ label: string; patch: Record<string, unknown>; code: LedgerEntryErrorCode }> = [
  { label: 'unknown direction', patch: { direction: 'LOSS' }, code: 'INVALID_DIRECTION' },
  { label: 'lowercase direction', patch: { direction: 'debit' }, code: 'INVALID_DIRECTION' },
  { label: 'missing direction', patch: { direction: undefined }, code: 'INVALID_DIRECTION' },
  { label: 'numeric direction', patch: { direction: 0 }, code: 'INVALID_DIRECTION' },
  { label: 'zero movement', patch: { money: Money.zero('BRL') }, code: 'NON_POSITIVE_MOVEMENT' },
  { label: 'negative movement from negate', patch: { money: amount('25.00').negate() }, code: 'NON_POSITIVE_MOVEMENT' },
  { label: 'negative movement from subtract', patch: { money: Money.zero('BRL').subtract(amount('0.01')) }, code: 'NON_POSITIVE_MOVEMENT' },
  { label: 'negative before balance', patch: { balanceBefore: amount('1.00').negate() }, code: 'NEGATIVE_BALANCE' },
  { label: 'negative after balance', patch: { balanceAfter: amount('1.00').negate() }, code: 'NEGATIVE_BALANCE' },
  { label: 'different movement currency', patch: { money: amount('25.00', 'USD') }, code: 'CURRENCY_MISMATCH' },
  { label: 'different before currency', patch: { balanceBefore: amount('100.00', 'EUR') }, code: 'CURRENCY_MISMATCH' },
  { label: 'different after currency', patch: { balanceAfter: amount('75.00', 'USD') }, code: 'CURRENCY_MISMATCH' },
  { label: 'invalid Date', patch: { createdAt: new Date('invalid') }, code: 'INVALID_CREATED_AT' },
  { label: 'string date', patch: { createdAt: '2026-10-22T12:00:00Z' }, code: 'INVALID_CREATED_AT' },
  { label: 'missing date', patch: { createdAt: undefined }, code: 'INVALID_CREATED_AT' },
  { label: 'null date', patch: { createdAt: null }, code: 'INVALID_CREATED_AT' },
  { label: 'Money DTO instead of instance', patch: { money: { amount: '25.00', currency: 'BRL' } }, code: 'INVALID_MONEY' },
  { label: 'missing before balance', patch: { balanceBefore: undefined }, code: 'INVALID_MONEY' },
  { label: 'null after balance', patch: { balanceAfter: null }, code: 'INVALID_MONEY' },
];

for (const factory of ['create', 'rehydrate'] as const) {
  test.each(invalidCases)(`${factory} rejects $label`, ({ patch, code }) => {
    expectCode(() => WalletLedgerEntry[factory]({ ...state(), ...patch } as LedgerEntryState), code);
  });

  test.each([{ input: null }, { input: undefined }, { input: [] }, { input: 'entry' }])
  (`${factory} rejects a malformed state: case %#`, ({ input }) => {
    expectCode(() => WalletLedgerEntry[factory](input as unknown as LedgerEntryState), 'INVALID_STATE');
  });

  test.each(['id', 'walletId', 'transactionId'] as const)
  (`${factory} rejects invalid %s values without normalizing them`, (field) => {
    for (const invalid of ['', ' ', ' id', 'id ', 'two words', 'id\n', 'id\u0000', 'id\u007f', null, undefined, 123]) {
      expectCode(() => WalletLedgerEntry[factory]({ ...state(), [field]: invalid } as LedgerEntryState), 'INVALID_IDENTIFIER');
    }
  });

  test(`${factory} freezes every public field and isolates mutable dates`, () => {
    const input = { ...state() };
    const entry = WalletLedgerEntry[factory](input);
    const originalTime = entry.createdAt.getTime();
    const alternatives: Record<keyof LedgerEntryState, unknown> = {
      id: 'changed', walletId: 'changed', transactionId: 'changed', direction: LedgerDirection.Credit,
      money: amount('1.00'), balanceBefore: amount('1.00'), balanceAfter: amount('1.00'), createdAt: new Date(0),
    };
    for (const [field, replacement] of Object.entries(alternatives)) {
      expect(Reflect.set(entry, field, replacement)).toBe(false);
    }
    expect(() => Object.defineProperty(entry, 'createdAt', { value: new Date(0) })).toThrow(TypeError);
    expect(Reflect.deleteProperty(entry, 'id')).toBe(false);
    input.id = 'changed';
    input.money = amount('99.00');
    input.createdAt.setTime(0);
    const exposedDate = entry.createdAt;
    exposedDate.setUTCFullYear(2000);
    const exposedMoney = entry.money.toJSON();
    exposedMoney.amount = '99.00';
    expect(entry.createdAt.getTime()).toBe(originalTime);
    expect(entry.createdAt).not.toBe(entry.createdAt);
    expect(entry.id).toBe('entry-1');
    expect(entry.money.toString()).toBe('25.00 BRL');
    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });
}

test('rehydrates an existing entry without generating new identity or changing its state', () => {
  const input = state();
  const created = WalletLedgerEntry.create(input);
  const restored = WalletLedgerEntry.rehydrate(input);
  expect(restored).not.toBe(created);
  for (const field of ['id', 'walletId', 'transactionId', 'direction'] as const) {
    expect(restored[field]).toBe(created[field]);
  }
  for (const field of ['money', 'balanceBefore', 'balanceAfter'] as const) {
    expect(restored[field].equals(created[field])).toBe(true);
  }
  expect(restored.createdAt.getTime()).toBe(created.createdAt.getTime());
  expect(restored.isBalanced()).toBe(true);
});

test.each(['BRL', 'USD', 'EUR'])('uses exact decimal arithmetic for %s credits and debits', (currency) => {
  const credit = WalletLedgerEntry.create(state({ direction: LedgerDirection.Credit,
    money: amount('0.20', currency), balanceBefore: amount('0.10', currency), balanceAfter: amount('0.30', currency) }));
  const debit = WalletLedgerEntry.create(state({ money: amount('0.20', currency),
    balanceBefore: amount('0.30', currency), balanceAfter: amount('0.10', currency) }));
  expect(credit.isBalanced()).toBe(true);
  expect(debit.isBalanced()).toBe(true);
});

test('retains Money precision for large amounts without converting to number', () => {
  const before = amount('999999999999999999999999999999.99');
  const after = amount('1000000000000000000000000000000.00');
  const entry = WalletLedgerEntry.create(state({ direction: LedgerDirection.Credit,
    money: amount('0.01'), balanceBefore: before, balanceAfter: after }));
  expect(entry.isBalanced()).toBe(true);
  expect(entry.balanceAfter.toJSON().amount).toBe('1000000000000000000000000000000.00');
});

test('rejects direct construction in JavaScript without the private token', () => {
  expect(() => Reflect.construct(WalletLedgerEntry, [state()])).toThrow(TypeError);
  expect(() => Reflect.construct(WalletLedgerEntry, [state(), Symbol('WalletLedgerEntry construction')])).toThrow(TypeError);
});

test('ledger dependency graph stays in the domain with decimal.js as its only external dependency', async () => {
  const root = fileURLToPath(new URL('../src/domain/', import.meta.url));
  const pending = [resolve(root, 'wallet/wallet-ledger-entry.ts')];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    expect(file.startsWith(root)).toBe(true);
    const source = await readFile(file, 'utf8');
    for (const dependency of ts.preProcessFile(source).importedFiles) {
      if (dependency.fileName.startsWith('.')) {
        pending.push(resolve(dirname(file), dependency.fileName.replace(/\.js$/, '.ts')));
      } else {
        expect(dependency.fileName).toBe('decimal.js');
      }
    }
  }
  expect(visited.size).toBeGreaterThan(1);
});
