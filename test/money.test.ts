import { expect, test } from 'bun:test';
import { Decimal } from 'decimal.js';
import { Money, type MoneyProps } from '../src/domain/money/money.js';
import { MoneyError } from '../src/domain/money/money-error.js';

test('creates a value object from a two-place decimal contract', () => {
  const money = Money.from({ amount: '25.00', currency: 'BRL' });
  expect(money.currency).toBe('BRL');
  expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  expect(money.toString()).toBe('25.00 BRL');
});

test('adds decimal fractions exactly without binary floating-point conversion', () => {
  const first = Money.from({ amount: '0.10', currency: 'BRL' });
  const second = Money.from({ amount: '0.20', currency: 'BRL' });
  expect(first.add(second).toJSON().amount).toBe('0.30');
  expect(first.add(second).subtract(first).equals(second)).toBe(true);
});

test('subtracts exactly and permits negative mathematical results', () => {
  const five = Money.from({ amount: '5.00', currency: 'BRL' });
  const eight = Money.from({ amount: '8.25', currency: 'BRL' });
  expect(eight.subtract(five).toJSON().amount).toBe('3.25');
  expect(five.subtract(eight).toJSON().amount).toBe('-3.25');
  expect(five.subtract(eight).add(eight).equals(five)).toBe(true);
});

test('negation reverses sign and two negations restore the original value', () => {
  const value = Money.from({ amount: '12.34', currency: 'BRL' });
  expect(value.negate().toJSON().amount).toBe('-12.34');
  expect(value.negate().negate().equals(value)).toBe(true);
  expect(value.add(value.negate()).isZero()).toBe(true);
});

test('compares signed amounts and value equality independently of object identity', () => {
  const value = Money.from({ amount: '12.34', currency: 'BRL' });
  const equal = Money.from({ amount: '12.34', currency: 'BRL' });
  const larger = Money.from({ amount: '12.35', currency: 'BRL' });
  expect(value).not.toBe(equal);
  expect(value.equals(equal)).toBe(true);
  expect(value.equals(larger)).toBe(false);
  expect(value.isLessThan(larger)).toBe(true);
  expect(value.isLessThan(equal)).toBe(false);
  expect(larger.isLessThan(value)).toBe(false);
  expect(value.negate().isLessThan(Money.zero('BRL'))).toBe(true);
  expect(larger.negate().isLessThan(value.negate())).toBe(true);
});

test('classifies positive, negative and zero without treating zero as positive or negative', () => {
  const positive = Money.from({ amount: '0.01', currency: 'BRL' });
  const negative = positive.negate();
  const zero = Money.zero('BRL');
  expect([positive.isZero(), positive.isPositive(), positive.isNegative()]).toEqual([false, true, false]);
  expect([negative.isZero(), negative.isPositive(), negative.isNegative()]).toEqual([false, false, true]);
  expect([zero.isZero(), zero.isPositive(), zero.isNegative()]).toEqual([true, false, false]);
  expect(zero.equals(Money.from({ amount: '0.00', currency: 'BRL' }))).toBe(true);
  expect(zero.negate().toJSON().amount).toBe('0.00');
  expect(zero.negate().isNegative()).toBe(false);
  expect(positive.subtract(positive).toJSON().amount).toBe('0.00');
});

test.each([
  '', ' ', 'NaN', 'Infinity', '-Infinity', '1e2', '1E+2', '1e-2',
  '25', '25.0', '25.001', '25.000', '-25.00', '-0.00', '+25.00',
  ' 25.00', '25.00 ', '25.00\n', '25,00', '1,000.00', '.25', '25.',
  '1_000.00', '0xff.00', '１２.００', 'abc',
])('rejects invalid external decimal syntax: case %#', (amount) => {
  expect(() => Money.from({ amount, currency: 'BRL' }))
    .toThrow(new MoneyError('INVALID_AMOUNT', 'Amount must be a non-negative decimal string with exactly two decimal places'));
});

test.each([
  { amount: 25 }, { amount: NaN }, { amount: Infinity }, { amount: null },
  { amount: undefined }, { amount: {} }, { amount: ['25.00'] },
])('rejects non-string runtime amounts without coercion: case %#', ({ amount }) => {
  const input = { amount, currency: 'BRL' } as unknown as MoneyProps;
  expect(() => Money.from(input)).toThrow(MoneyError);
});

test.each([{ input: null }, { input: undefined }, { input: {} }, { input: [] }, { input: '25.00' }])
('rejects malformed runtime contracts: case %#', ({ input }) => {
  expect(() => Money.from(input as MoneyProps)).toThrow(MoneyError);
});

test('does not admit a signed internal result back through the external factory', () => {
  const negative = Money.zero('BRL').subtract(Money.from({ amount: '1.00', currency: 'BRL' }));
  expect(negative.isNegative()).toBe(true);
  expect(() => Money.from(negative.toJSON())).toThrow(MoneyError);
});

test('all arithmetic returns new instances and leaves both operands unchanged', () => {
  const left = Money.from({ amount: '25.00', currency: 'BRL' });
  const right = Money.from({ amount: '10.00', currency: 'BRL' });
  for (const result of [left.add(right), left.subtract(right), left.negate(), left.add(Money.zero('BRL'))]) {
    expect(result).not.toBe(left);
    expect(result).not.toBe(right);
  }
  expect(left.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  expect(right.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  const zero = Money.zero('BRL');
  expect(zero.negate()).not.toBe(zero);
});

test('freezes public state and never retains mutable input or output objects', () => {
  const input = { amount: '25.00', currency: 'BRL' };
  const money = Money.from(input);
  input.amount = '99.00';
  input.currency = 'USD';
  const output = money.toJSON();
  output.amount = '88.00';
  output.currency = 'EUR';
  expect(Object.isFrozen(money)).toBe(true);
  expect(Reflect.set(money, 'currency', 'USD')).toBe(false);
  expect(Reflect.set(money, 'value', '99.00')).toBe(false);
  expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
});

test('JSON serialization uses fixed two-place strings including internal negatives', () => {
  const money = Money.from({ amount: '25.10', currency: 'BRL' });
  expect(JSON.stringify(money)).toBe('{"amount":"25.10","currency":"BRL"}');
  expect(JSON.stringify(money.negate())).toBe('{"amount":"-25.10","currency":"BRL"}');
  expect(JSON.stringify(Money.zero('BRL'))).toBe('{"amount":"0.00","currency":"BRL"}');
});

test('example: initial amount minus a stake plus a prize yields an exact new amount', () => {
  const initial = Money.from({ amount: '100.00', currency: 'BRL' });
  const stake = Money.from({ amount: '25.00', currency: 'BRL' });
  const prize = Money.from({ amount: '40.50', currency: 'BRL' });
  const afterStake = initial.subtract(stake);
  const afterPrize = afterStake.add(prize);
  expect(initial.toString()).toBe('100.00 BRL');
  expect(afterStake.toString()).toBe('75.00 BRL');
  expect(afterPrize.toString()).toBe('115.50 BRL');
});

test.each(['BRL', 'USD', 'EUR'])('supports %s with fixed scale and a validated zero factory', (currency) => {
  const value = Money.from({ amount: '25.00', currency });
  expect(value.add(Money.zero(currency)).equals(value)).toBe(true);
  expect(Money.zero(currency).toJSON()).toEqual({ amount: '0.00', currency });
});

test.each(['', 'brl', ' BRL', 'BRL ', 'BRL\n', 'XYZ', 'JPY', null, undefined, 123])
('rejects unsupported or malformed currencies in both factories: case %#', (currency) => {
  expect(() => Money.from({ amount: '25.00', currency } as MoneyProps)).toThrow(MoneyError);
  expect(() => Money.zero(currency as string)).toThrow(MoneyError);
});

test.each(['add', 'subtract', 'isLessThan', 'equals'] as const)
('%s rejects different currencies instead of converting or comparing them', (method) => {
  const brl = Money.from({ amount: '25.00', currency: 'BRL' });
  const usd = Money.from({ amount: '25.00', currency: 'USD' });
  expect(() => brl[method](usd)).toThrow(MoneyError);
  expect(() => usd[method](brl)).toThrow(MoneyError);
});

test('domain failures have stable codes without requiring framework exceptions', () => {
  const value = Money.from({ amount: '1.00', currency: 'BRL' });
  const scenarios = [
    { run: () => Money.from({ amount: '-1.00', currency: 'BRL' }), code: 'INVALID_AMOUNT' },
    { run: () => Money.zero('XYZ'), code: 'UNSUPPORTED_CURRENCY' },
    { run: () => value.equals(Money.zero('USD')), code: 'CURRENCY_MISMATCH' },
  ];
  expect.assertions(9);
  for (const scenario of scenarios) {
    try {
      scenario.run();
    } catch (error) {
      expect(error).toBeInstanceOf(MoneyError);
      expect(error).toHaveProperty('name', 'MoneyError');
      expect(error).toHaveProperty('code', scenario.code);
    }
  }
});

test('canonicalizes redundant leading zeros without changing the amount or scale', () => {
  expect(Money.from({ amount: '00025.10', currency: 'BRL' }).toJSON().amount).toBe('25.10');
});

test('private construction also rejects direct JavaScript calls at runtime', () => {
  expect(() => Reflect.construct(Money, [new Decimal('-25.00'), 'BRL'])).toThrow(TypeError);
  expect(() => Reflect.construct(Money, [new Decimal('25.001'), 'BRL', Symbol('Money construction')]))
    .toThrow(TypeError);
});

test.each([25, 100, 1_000])('preserves cents, carry, borrow and cancellation with %i integer digits', (digits) => {
  const amount = `${'9'.repeat(digits)}.99`;
  const nextAmount = `1${'0'.repeat(digits)}.00`;
  const huge = Money.from({ amount, currency: 'BRL' });
  const cent = Money.from({ amount: '0.01', currency: 'BRL' });
  const next = huge.add(cent);
  expect(huge.toJSON().amount).toBe(amount);
  expect(next.toJSON().amount).toBe(nextAmount);
  expect(next.subtract(cent).equals(huge)).toBe(true);
  expect(next.subtract(huge).equals(cent)).toBe(true);
  expect(huge.subtract(next).toJSON().amount).toBe('-0.01');
  expect(huge.negate().subtract(cent).toJSON().amount).toBe(`-${nextAmount}`);
  expect(huge.negate().add(cent.negate()).toJSON().amount).toBe(`-${nextAmount}`);
  expect(next.add(huge.negate()).equals(cent)).toBe(true);
  expect(huge.negate().negate().equals(huge)).toBe(true);
  expect(huge.add(huge.negate()).toJSON().amount).toBe('0.00');
});

test('external Decimal configuration cannot lower Money precision or exponent range', () => {
  const previous = {
    precision: Decimal.precision, rounding: Decimal.rounding, minE: Decimal.minE, maxE: Decimal.maxE,
  };
  try {
    Decimal.set({ precision: 1, rounding: Decimal.ROUND_UP, minE: -1, maxE: 1 });
    const large = Money.from({ amount: '123456789012345678901234567890.12', currency: 'BRL' });
    const cent = Money.from({ amount: '0.01', currency: 'BRL' });
    expect(large.add(cent).toJSON().amount).toBe('123456789012345678901234567890.13');
    expect(large.subtract(cent).toJSON().amount).toBe('123456789012345678901234567890.11');
    expect(large.negate().toJSON().amount).toBe('-123456789012345678901234567890.12');
    expect(cent.isPositive()).toBe(true);
  } finally {
    Decimal.set(previous);
  }
});
