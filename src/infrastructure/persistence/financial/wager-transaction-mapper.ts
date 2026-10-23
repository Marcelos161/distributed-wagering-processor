import { readTimestamp } from './timestamp-mapper.js';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wagering/wager-transaction.js';
import { FailureCode } from '../../../domain/wagering/failure-code.js';
import { MoneyMapper } from './money-mapper.js';

export interface WagerTransactionRecord {
  id: string; provider_id: string; external_transaction_id: string; idempotency_key: string;
  payload_hash: string; wallet_id: string; player_id: string; round_id: string; game_id: string;
  kind: string; amount: string; currency: string; status: string;
  reference_external_transaction_id: string | null; reference_transaction_id: string | null;
  failure_code: string | null; created_at: Date | string; processed_at: Date | string | null;
}

export class WagerTransactionMapper {
  static toDomain(row: WagerTransactionRecord): WagerTransaction {
    // Enum casts do not validate: rehydrate performs runtime structural validation.
    return WagerTransaction.rehydrate({ id: row.id, providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id, idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash, walletId: row.wallet_id, playerId: row.player_id,
      roundId: row.round_id, gameId: row.game_id, kind: row.kind as WagerTransactionKind,
      money: MoneyMapper.toDomain(row.amount, row.currency), status: row.status as WagerTransactionStatus,
      ...(row.reference_external_transaction_id === null ? {} : { referenceExternalTransactionId: row.reference_external_transaction_id }),
      referenceTransactionId: row.reference_transaction_id ?? undefined,
      failureCode: (row.failure_code ?? undefined) as FailureCode | undefined,
      createdAt: readTimestamp(row.created_at), processedAt: row.processed_at === null ? undefined : readTimestamp(row.processed_at) });
  }

  static toRecord(transaction: WagerTransaction): WagerTransactionRecord {
    return { id: transaction.id, provider_id: transaction.providerId,
      external_transaction_id: transaction.externalTransactionId, idempotency_key: transaction.idempotencyKey,
      payload_hash: transaction.payloadHash, wallet_id: transaction.walletId, player_id: transaction.playerId,
      round_id: transaction.roundId, game_id: transaction.gameId, kind: transaction.kind,
      amount: MoneyMapper.toRecord(transaction.money), currency: transaction.money.currency,
      status: transaction.status, reference_external_transaction_id: transaction.referenceExternalTransactionId ?? null,
      reference_transaction_id: transaction.referenceTransactionId ?? null, failure_code: transaction.failureCode ?? null,
      created_at: transaction.createdAt, processed_at: transaction.processedAt ?? null };
  }
}
