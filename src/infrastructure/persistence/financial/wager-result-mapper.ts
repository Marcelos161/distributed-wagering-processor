import type { WagerResultSnapshot } from '../../../application/wagering/wager-result.js';
import { Money } from '../../../domain/money/money.js';
import { FailureCode } from '../../../domain/wagering/failure-code.js';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction.js';
import { MoneyMapper } from './money-mapper.js';

export interface WagerResultRecord {
  transaction_id: string; schema_version: number; wallet_version: string; response: unknown;
}
export class WagerResultMapper {
  static toSnapshot(row: WagerResultRecord): WagerResultSnapshot {
    const p = row.response;
    if (row.schema_version !== 1 || !p || typeof p !== 'object' || Array.isArray(p)
      || !('transactionId' in p) || p.transactionId !== row.transaction_id
      || typeof p.transactionId !== 'string' || !p.transactionId || /[\s\u0000-\u001f\u007f]/u.test(p.transactionId)
      || !('status' in p) || !('balance' in p) || !p.balance || typeof p.balance !== 'object' || Array.isArray(p.balance)
      || !('amount' in p.balance) || typeof p.balance.amount !== 'string'
      || !('currency' in p.balance) || typeof p.balance.currency !== 'string') throw new TypeError('Invalid stored wager result');
    const money = Money.from({ amount: p.balance.amount, currency: p.balance.currency });
    MoneyMapper.toRecord(money); // Same storage cap as every financial record.
    const failure = 'failureCode' in p ? p.failureCode : undefined;
    if (!((p.status === WagerTransactionStatus.Processed && !('failureCode' in p))
      || (p.status === WagerTransactionStatus.Rejected && [FailureCode.InsufficientFunds, FailureCode.DomainRuleViolation].some(code => code === failure))
      || (p.status === WagerTransactionStatus.Failed && failure === FailureCode.PermanentInfrastructureFailure))
      || Object.keys(p).length !== (failure === undefined ? 3 : 4) || Object.keys(p.balance).length !== 2
      || money.toJSON().amount !== p.balance.amount
      || !/^[1-9][0-9]*$/.test(row.wallet_version) || BigInt(row.wallet_version) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError('Inconsistent stored wager result');
    }
    return Object.freeze({ transactionId: p.transactionId, status: p.status as WagerResultSnapshot['status'],
      balance: Object.freeze(money.toJSON()), ...(failure === undefined ? {} : { failureCode: failure as FailureCode }) });
  }
  static toRecord(result: WagerResultSnapshot, walletVersion: number): WagerResultRecord {
    if (!Number.isSafeInteger(walletVersion) || walletVersion < 1) throw new RangeError('Invalid result wallet version');
    const row = { transaction_id: result.transactionId, schema_version: 1, wallet_version: String(walletVersion), response: result };
    return { ...row, response: this.toSnapshot(row) };
  }
}
