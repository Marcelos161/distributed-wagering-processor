import { InvalidWagerInputError, prepareWager, type WagerInput } from '../../application/wagering/prepare-wager.js';
import type { CreateWalletInput } from '../../application/wallet/create-wallet.js';
import { Money } from '../../domain/money/money.js';
export function objectFields(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidWagerInputError('Expected object');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(row, k))) throw new InvalidWagerInputError('Invalid fields');
  return row;
}
export function token(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 200 || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new InvalidWagerInputError('Invalid identifier');
  return value;
}
function money(value: unknown) {
  const row = objectFields(value, ['amount', 'currency']);
  if (typeof row.amount !== 'string' || row.amount.length > 64 || typeof row.currency !== 'string') throw new InvalidWagerInputError('Invalid money');
  return Money.from({ amount: row.amount, currency: row.currency }).toJSON();
}
export function walletInput(value: unknown): CreateWalletInput {
  const row = objectFields(value, ['playerId', 'initialBalance']);
  const balance = money(row.initialBalance);
  if (Money.from({ amount: '999999999999999999.99', currency: balance.currency }).isLessThan(Money.from(balance))) throw new InvalidWagerInputError('Storage limit');
  return { playerId: token(row.playerId), initialBalance: balance };
}
export function wagerInput(value: unknown, key: unknown, transport: 'http' | 'sqs' = 'http'): WagerInput {
  const required = ['providerId','externalTransactionId','playerId','walletId','roundId','gameId','kind','money'];
  const row = objectFields(value, [...required, 'referenceExternalTransactionId', ...(transport === 'sqs' ? ['idempotencyKey'] : [])], required);
  for (const field of required.filter(f => f !== 'money')) token(row[field]);
  if (row.referenceExternalTransactionId !== undefined) token(row.referenceExternalTransactionId);
  return prepareWager({ ...row, money: money(row.money), idempotencyKey: token(key) } as unknown as WagerInput).input;
}
