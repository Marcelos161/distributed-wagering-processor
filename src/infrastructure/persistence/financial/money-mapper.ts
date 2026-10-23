import { Money } from '../../../domain/money/money.js';

/** Exact boundary for the non-negative financial_amount PostgreSQL domain. */
export class MoneyMapper {
  static toDomain(amount: string, currency: string): Money {
    if (typeof amount !== 'string' || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(amount)) {
      throw new TypeError('Persisted amount must be an unsigned decimal string with at most two places');
    }
    const [integer = '', fraction = ''] = amount.split('.');
    const normalized = integer.replace(/^0+(?=\d)/, '');
    if (normalized.length > 18) throw new RangeError('Amount exceeds financial_amount storage limit');
    return Money.from({ amount: `${normalized}.${fraction.padEnd(2, '0')}`, currency });
  }

  static toRecord(money: Money): string {
    const { amount, currency } = money.toJSON();
    return MoneyMapper.toDomain(amount, currency).toJSON().amount;
  }
}

/** Versions are counters, not money; check the safe-integer bound before conversion. */
export function readVersion(value: string): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)
    || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Persisted version must be a positive safe integer string');
  }
  return Number(value);
}

export function writeVersion(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid wallet version');
  return String(value);
}
