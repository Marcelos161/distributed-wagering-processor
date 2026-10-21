import { Decimal } from 'decimal.js';
import { MoneyError } from './money-error.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const supportedCurrencies = new Set(['BRL', 'USD', 'EUR']);
const constructionToken = Symbol('Money construction');
// This constructor is private to the module; Decimal.set elsewhere cannot change it.
const MoneyDecimal = Decimal.clone({
  precision: 20,
  rounding: Decimal.ROUND_HALF_EVEN,
  minE: -9e15,
  maxE: 9e15,
});

export class Money {
  readonly #value: Decimal;
  public readonly currency: string;

  private constructor(value: Decimal, currency: string, token: typeof constructionToken) {
    // TypeScript's private constructor is erased in JS; keep the factory boundary at runtime.
    if (token !== constructionToken) throw new TypeError('Use Money.from or Money.zero to construct Money');
    this.#value = value.isZero() ? new MoneyDecimal('0') : value;
    this.currency = currency;
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (!props || typeof props !== 'object' || Array.isArray(props)
      || typeof props.amount !== 'string' || props.amount.trim() !== props.amount
      || !/^[0-9]+\.[0-9]{2}$/.test(props.amount)) {
      throw new MoneyError('INVALID_AMOUNT', 'Amount must be a non-negative decimal string with exactly two decimal places');
    }
    if (typeof props.currency !== 'string' || !supportedCurrencies.has(props.currency)) {
      throw new MoneyError('UNSUPPORTED_CURRENCY', 'Currency must be one of BRL, USD, EUR');
    }
    // Construction from a string is exact; precision applies to arithmetic, not parsing.
    return new Money(new MoneyDecimal(props.amount), props.currency, constructionToken);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    return this.#calculate(other, 'add');
  }

  subtract(other: Money): Money {
    return this.#calculate(other, 'subtract');
  }

  negate(): Money {
    return new Money(this.#value.negated(), this.currency, constructionToken);
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isPositive(): boolean {
    return this.#value.greaterThan('0');
  }

  isNegative(): boolean {
    return this.#value.lessThan('0');
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.lessThan(other.#value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.equals(other.#value);
  }

  toJSON(): MoneyProps {
    return { amount: this.#value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.#value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError('CURRENCY_MISMATCH', 'Money operands must have the same currency');
    }
  }

  #calculate(other: Money, operation: 'add' | 'subtract'): Money {
    this.assertSameCurrency(other);
    const left = this.#value.toFixed(2);
    const right = other.#value.toFixed(2);
    // Digit count plus room for carry. Counting punctuation/sign only overestimates precision.
    const ExactDecimal = MoneyDecimal.clone({ precision: Math.max(left.length, right.length) + 1 });
    const value = new ExactDecimal(left);
    const result = operation === 'add' ? value.plus(right) : value.minus(right);
    return new Money(result, this.currency, constructionToken);
  }
}
