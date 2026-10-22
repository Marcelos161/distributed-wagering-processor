import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Money } from '../src/domain/money/money.js';
import { WalletError, type WalletErrorCode } from '../src/domain/wallet/wallet-error.js';
import { LedgerEntryError } from '../src/domain/wallet/ledger-entry-error.js';
import { LedgerDirection } from '../src/domain/wallet/wallet-ledger-entry.js';
import { Wallet, type OpenWalletProps, type WalletMovementProps, type WalletState } from '../src/domain/wallet/wallet.js';

function money(amount: string, currency = 'BRL'): Money {
  return Money.from({ amount, currency });
}

function opening(overrides: Partial<OpenWalletProps> = {}): OpenWalletProps {
  return {
    id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00'),
    at: new Date('2026-10-22T12:00:00.000Z'),
    opening: { ledgerEntryId: 'entry-opening', transactionId: 'tx-opening' },
    ...overrides,
  };
}

function persisted(overrides: Partial<WalletState> = {}): WalletState {
  return {
    id: 'wallet-1', playerId: 'player-1', currency: 'BRL', balance: money('100.00'), version: 7,
    createdAt: new Date('2026-10-22T12:00:00.000Z'), updatedAt: new Date('2026-10-22T13:00:00.000Z'),
    ...overrides,
  };
}

function movement(overrides: Partial<WalletMovementProps> = {}): WalletMovementProps {
  return {
    ledgerEntryId: 'entry-1', transactionId: 'tx-1', money: money('25.00'),
    at: new Date('2026-10-22T14:00:00.000Z'), ...overrides,
  };
}

function snapshot(wallet: Wallet) {
  return {
    id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
    balance: wallet.balance.toJSON(), version: wallet.version,
    createdAt: wallet.createdAt.toISOString(), updatedAt: wallet.updatedAt.toISOString(),
  };
}

function expectCode(run: () => unknown, code: WalletErrorCode): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(WalletError);
  expect(caught).toHaveProperty('name', 'WalletError');
  expect(caught).toHaveProperty('code', code);
}

test('opens a zero balance with version one and no opening movement', () => {
  const input: OpenWalletProps = { id: 'wallet-zero', playerId: 'player-1', initialBalance: Money.zero('BRL'), at: new Date(0) };
  const result = Wallet.open(input);
  expect(result.openingEntry).toBeNull();
  expect(snapshot(result.wallet)).toEqual({
    id: 'wallet-zero', playerId: 'player-1', currency: 'BRL', balance: { amount: '0.00', currency: 'BRL' },
    version: 1, createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z',
  });
  expect(Object.isFrozen(result)).toBe(true);
});

test('positive opening returns a balanced credit linked to the supplied OPENING identity with version one', () => {
  const input = opening();
  const { wallet, openingEntry } = Wallet.open(input);
  expect(wallet.balance.equals(input.initialBalance)).toBe(true);
  expect(wallet.version).toBe(1);
  expect(wallet.createdAt.getTime()).toBe(wallet.updatedAt.getTime());
  expect(openingEntry?.id).toBe('entry-opening');
  expect(openingEntry?.transactionId).toBe('tx-opening');
  expect(openingEntry?.walletId).toBe(wallet.id);
  expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
  expect(openingEntry?.money.equals(wallet.balance)).toBe(true);
  expect(openingEntry?.balanceBefore.isZero()).toBe(true);
  expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
  expect(openingEntry?.createdAt.getTime()).toBe(wallet.createdAt.getTime());
  expect(openingEntry?.isBalanced()).toBe(true);
});

test.each([{ context: undefined }, { context: null }, { context: [] }, { context: 'tx-opening' }])
('positive opening requires a structured opening context: case %#', ({ context }) => {
  expectCode(() => Wallet.open({ ...opening(), opening: context } as unknown as OpenWalletProps), 'INVALID_OPENING_CONTEXT');
});

test('zero opening refuses unused movement identities', () => {
  expectCode(() => Wallet.open(opening({ initialBalance: Money.zero('BRL') })), 'INVALID_OPENING_CONTEXT');
});

test.each(['ledgerEntryId', 'transactionId'] as const)('positive opening requires valid %s for its ledger', (field) => {
  const input = opening();
  expect(() => Wallet.open({ ...input, opening: { ledgerEntryId: 'entry', transactionId: 'tx', [field]: '' } }))
    .toThrow(LedgerEntryError);
  expect(input.initialBalance.toString()).toBe('100.00 BRL');
});

test('opening rejects an internally negative Money balance', () => {
  expectCode(() => Wallet.open(opening({ initialBalance: money('1.00').negate() })), 'NEGATIVE_BALANCE');
});

test.each(['BRL', 'USD', 'EUR'])('wallet derives %s from Money and preserves exact decimal credit/debit', (currency) => {
  const { wallet } = Wallet.open(opening({ initialBalance: money('0.10', currency) }));
  const credit = wallet.credit(movement({ money: money('0.20', currency) }));
  expect(wallet.currency).toBe(currency);
  expect(wallet.balance.toJSON().amount).toBe('0.30');
  expect(credit.entry.isBalanced()).toBe(true);
  const debit = wallet.debit(movement({ money: money('0.20', currency), ledgerEntryId: 'entry-2', transactionId: 'tx-2' }));
  expect(wallet.balance.toJSON().amount).toBe('0.10');
  expect(debit.entry.isBalanced()).toBe(true);
  expect(wallet.version).toBe(3);
});

test('debit and credit return immutable ledger/version snapshots and preserve the earlier result', () => {
  const { wallet, openingEntry } = Wallet.open(opening());
  const before = wallet.balance;
  const debit = wallet.debit(movement());
  expect(debit.entry.direction).toBe(LedgerDirection.Debit);
  expect(debit.entry.walletId).toBe(wallet.id);
  expect(debit.entry.transactionId).toBe('tx-1');
  expect(debit.entry.id).toBe('entry-1');
  expect(debit.entry.balanceBefore).toBe(before);
  expect(debit.entry.balanceAfter).toBe(wallet.balance);
  expect(debit.entry.money.toJSON().amount).toBe('25.00');
  expect(debit.entry.isBalanced()).toBe(true);
  expect(wallet.balance.toString()).toBe('75.00 BRL');
  expect(wallet.version).toBe(2);
  expect(debit.walletVersion).toBe(2);
  expect(wallet.updatedAt.getTime()).toBe(debit.entry.createdAt.getTime());
  const credit = wallet.credit(movement({ money: money('40.50'), ledgerEntryId: 'entry-2', transactionId: 'tx-2', at: new Date('2026-10-22T15:00:00Z') }));
  expect(credit.entry.direction).toBe(LedgerDirection.Credit);
  expect(credit.entry.balanceBefore).toBe(debit.entry.balanceAfter);
  expect(credit.entry.balanceAfter).toBe(wallet.balance);
  expect(wallet.balance.toString()).toBe('115.50 BRL');
  expect(wallet.version).toBe(3);
  expect(credit.walletVersion).toBe(3);
  expect(credit.entry.isBalanced()).toBe(true);
  expect(debit.walletVersion).toBe(2);
  expect(debit.entry.balanceAfter.toString()).toBe('75.00 BRL');
  expect(openingEntry?.balanceAfter.toString()).toBe('100.00 BRL');
  expect(before.toString()).toBe('100.00 BRL');
  expect(Object.isFrozen(debit)).toBe(true);
  expect(Reflect.set(debit, 'walletVersion', 99)).toBe(false);
});

test('debit equal to the available balance is accepted and increments version once', () => {
  const { wallet } = Wallet.open(opening());
  const result = wallet.debit(movement({ money: money('100.00') }));
  expect(wallet.balance.isZero()).toBe(true);
  expect(wallet.version).toBe(2);
  expect(result.entry.isBalanced()).toBe(true);
});

test('insufficient funds is a stable domain rejection with no changes, even after a successful operation', () => {
  const { wallet } = Wallet.open(opening());
  wallet.debit(movement({ money: money('80.00') }));
  const before = snapshot(wallet);
  expectCode(() => wallet.debit(movement({ money: money('80.00') })), 'INSUFFICIENT_FUNDS');
  expect(snapshot(wallet)).toEqual(before);
  expect(wallet.balance.toString()).toBe('20.00 BRL');
  expect(wallet.version).toBe(2);
});

const invalidMovements: Array<{ label: string; patch: Record<string, unknown>; code: WalletErrorCode }> = [
  { label: 'zero', patch: { money: Money.zero('BRL') }, code: 'NON_POSITIVE_MOVEMENT' },
  { label: 'negative', patch: { money: money('0.01').negate() }, code: 'NON_POSITIVE_MOVEMENT' },
  { label: 'different currency', patch: { money: money('1.00', 'USD') }, code: 'CURRENCY_MISMATCH' },
  { label: 'Money DTO', patch: { money: { amount: '1.00', currency: 'BRL' } }, code: 'INVALID_MONEY' },
  { label: 'missing money', patch: { money: undefined }, code: 'INVALID_MONEY' },
  { label: 'invalid Date', patch: { at: new Date('invalid') }, code: 'INVALID_DATE' },
  { label: 'string date', patch: { at: '2026-10-22' }, code: 'INVALID_DATE' },
  { label: 'missing date', patch: { at: undefined }, code: 'INVALID_DATE' },
];

for (const method of ['debit', 'credit'] as const) {
  test.each(invalidMovements)(`${method} rejects $label without changing any wallet state`, ({ patch, code }) => {
    const wallet = Wallet.rehydrate(persisted());
    const before = snapshot(wallet);
    expectCode(() => wallet[method]({ ...movement(), ...patch } as WalletMovementProps), code);
    expect(snapshot(wallet)).toEqual(before);
  });

  test.each(['ledgerEntryId', 'transactionId'] as const)
  (`${method} preserves state when the real ledger factory rejects %s after calculation`, (field) => {
    const wallet = Wallet.rehydrate(persisted());
    const before = snapshot(wallet);
    expect(() => wallet[method]({ ...movement(), [field]: '' })).toThrow(LedgerEntryError);
    expect(snapshot(wallet)).toEqual(before);
    const valid = wallet[method](movement());
    expect(valid.entry.isBalanced()).toBe(true);
    expect(wallet.version).toBe(8);
  });

  test(`${method} refuses version overflow without changing the balance or time`, () => {
    const wallet = Wallet.rehydrate(persisted({ version: Number.MAX_SAFE_INTEGER }));
    const before = snapshot(wallet);
    expectCode(() => wallet[method](movement()), 'VERSION_EXHAUSTED');
    expect(snapshot(wallet)).toEqual(before);
  });

  test.each([{ input: null }, { input: undefined }, { input: [] }, { input: 'movement' }])
  (`${method} rejects malformed input: case %#`, ({ input }) => {
    const wallet = Wallet.rehydrate(persisted());
    const before = snapshot(wallet);
    expectCode(() => wallet[method](input as unknown as WalletMovementProps), 'INVALID_STATE');
    expect(snapshot(wallet)).toEqual(before);
  });
}

test('the last safe version increment is exact and the next one fails without side effects', () => {
  const wallet = Wallet.rehydrate(persisted({ version: Number.MAX_SAFE_INTEGER - 1 }));
  const result = wallet.credit(movement());
  expect(result.walletVersion).toBe(Number.MAX_SAFE_INTEGER);
  expect(wallet.balance.toString()).toBe('125.00 BRL');
  const before = snapshot(wallet);
  expectCode(() => wallet.credit(movement()), 'VERSION_EXHAUSTED');
  expect(snapshot(wallet)).toEqual(before);
});

test('rehydrate restores identity, balance, version and dates without replaying opening', () => {
  const input = persisted();
  const wallet = Wallet.rehydrate(input);
  expect(snapshot(wallet)).toEqual({
    id: input.id, playerId: input.playerId, currency: 'BRL', balance: input.balance.toJSON(), version: 7,
    createdAt: input.createdAt.toISOString(), updatedAt: input.updatedAt.toISOString(),
  });
  expect(wallet.balance).toBe(input.balance);
  const result = wallet.debit(movement());
  expect(result.entry.balanceBefore.toString()).toBe('100.00 BRL');
  expect(result.walletVersion).toBe(8);
});

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined])
('rehydrate rejects an invalid version: case %#', (version) => {
  expectCode(() => Wallet.rehydrate({ ...persisted(), version } as WalletState), 'INVALID_VERSION');
});

test('rehydrate rejects negative balance and mismatched or missing currency', () => {
  expectCode(() => Wallet.rehydrate(persisted({ balance: money('1.00').negate() })), 'NEGATIVE_BALANCE');
  for (const currency of ['USD', '', undefined]) {
    expectCode(() => Wallet.rehydrate({ ...persisted(), currency } as WalletState), 'CURRENCY_MISMATCH');
  }
});

for (const factory of ['open', 'rehydrate'] as const) {
  test.each(['id', 'playerId'] as const)(`${factory} validates %s without generating or normalizing it`, (field) => {
    for (const invalid of ['', ' ', ' id', 'id ', 'two words', 'id\n', 'id\u0000', null, 123, undefined]) {
      const run = factory === 'open'
        ? () => Wallet.open({ ...opening(), [field]: invalid } as OpenWalletProps)
        : () => Wallet.rehydrate({ ...persisted(), [field]: invalid } as WalletState);
      expectCode(run, 'INVALID_IDENTIFIER');
    }
  });

  test.each([{ input: null }, { input: undefined }, { input: [] }, { input: 'wallet' }])
  (`${factory} rejects malformed input: case %#`, ({ input }) => {
    expectCode(() => factory === 'open' ? Wallet.open(input as unknown as OpenWalletProps)
      : Wallet.rehydrate(input as unknown as WalletState), 'INVALID_STATE');
  });

  test(`${factory} rejects monetary DTOs and missing balances`, () => {
    for (const value of [undefined, null, { amount: '100.00', currency: 'BRL' }]) {
      expectCode(() => factory === 'open'
        ? Wallet.open({ ...opening(), initialBalance: value } as unknown as OpenWalletProps)
        : Wallet.rehydrate({ ...persisted(), balance: value } as unknown as WalletState), 'INVALID_MONEY');
    }
  });

  test(`${factory} protects identity, direct balance access and all exposed dates`, () => {
    const source = { ...persisted() };
    const at = new Date(source.createdAt);
    const wallet = factory === 'open' ? Wallet.open(opening({ at })).wallet : Wallet.rehydrate(source);
    const before = snapshot(wallet);
    for (const [field, value] of Object.entries({ id: 'x', playerId: 'x', currency: 'USD', balance: money('1.00'), version: 99, createdAt: new Date(0), updatedAt: new Date(0) })) {
      expect(Reflect.set(wallet, field, value)).toBe(false);
    }
    expect(() => Object.defineProperty(wallet, 'balance', { value: money('1.00') })).toThrow(TypeError);
    at.setTime(0);
    source.createdAt.setTime(0);
    source.updatedAt.setTime(0);
    source.balance = money('99.00');
    wallet.createdAt.setTime(0);
    wallet.updatedAt.setTime(0);
    const dto = wallet.balance.toJSON();
    dto.amount = '99.00';
    expect(snapshot(wallet)).toEqual(before);
    expect(Object.isFrozen(wallet.balance)).toBe(true);
    const movementAt = new Date('2026-10-22T14:00:00.000Z');
    const result = wallet.credit(movement({ at: movementAt }));
    movementAt.setTime(0);
    result.entry.createdAt.setTime(0);
    expect(wallet.updatedAt.toISOString()).toBe('2026-10-22T14:00:00.000Z');
    expect(wallet.createdAt.toISOString()).toBe(before.createdAt);
    expect(wallet.version).toBe(before.version + 1);
  });
}

test.each(['createdAt', 'updatedAt'] as const)('rehydrate rejects invalid %s', (field) => {
  for (const invalid of [new Date('invalid'), undefined, null, '2026-10-22']) {
    expectCode(() => Wallet.rehydrate({ ...persisted(), [field]: invalid } as WalletState), 'INVALID_DATE');
  }
});

test('open requires a valid supplied timestamp', () => {
  expectCode(() => Wallet.open(opening({ at: new Date('invalid') })), 'INVALID_DATE');
});

test('timestamps are supplied instants, not a distributed clock or an ordering guarantee', () => {
  const wallet = Wallet.rehydrate(persisted());
  wallet.credit(movement({ at: new Date('2026-10-22T11:59:59Z') }));
  expect(wallet.updatedAt.toISOString()).toBe('2026-10-22T11:59:59.000Z');
  expect(wallet.version).toBe(8);
});

test('large balances retain cents across credit and debit', () => {
  const initial = money(`${'9'.repeat(100)}.99`);
  const { wallet } = Wallet.open(opening({ initialBalance: initial }));
  const credit = wallet.credit(movement({ money: money('0.01') }));
  expect(wallet.balance.toJSON().amount).toBe(`1${'0'.repeat(100)}.00`);
  expect(credit.entry.isBalanced()).toBe(true);
  const debit = wallet.debit(movement({ money: money('0.01'), transactionId: 'tx-2', ledgerEntryId: 'entry-2' }));
  expect(wallet.balance.equals(initial)).toBe(true);
  expect(debit.entry.isBalanced()).toBe(true);
});

test('version does not prevent two independent copies from accepting conflicting debits', () => {
  const first = Wallet.rehydrate(persisted());
  const second = Wallet.rehydrate(persisted());
  first.debit(movement({ money: money('80.00') }));
  second.debit(movement({ money: money('80.00') }));
  expect(first.balance.toString()).toBe('20.00 BRL');
  expect(second.balance.toString()).toBe('20.00 BRL');
  expect(first.version).toBe(8);
  expect(second.version).toBe(8);
});

test('direct construction without the module-private token is refused', () => {
  expect(() => Reflect.construct(Wallet, [persisted()])).toThrow(TypeError);
  expect(() => Reflect.construct(Wallet, [persisted(), Symbol('Wallet construction')])).toThrow(TypeError);
});

test('wallet dependency graph contains domain code and decimal.js, with no framework or database', async () => {
  const root = fileURLToPath(new URL('../src/domain/', import.meta.url));
  const pending = [resolve(root, 'wallet/wallet.ts')];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    expect(file.startsWith(root)).toBe(true);
    for (const dependency of ts.preProcessFile(await readFile(file, 'utf8')).importedFiles) {
      if (dependency.fileName.startsWith('.')) {
        pending.push(resolve(dirname(file), dependency.fileName.replace(/\.js$/, '.ts')));
      } else {
        expect(dependency.fileName).toBe('decimal.js');
      }
    }
  }
  expect(visited.size).toBeGreaterThan(1);
});
