import type { WagerTransactionRepository } from '../../../application/ports/financial-persistence.js';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction.js';
import { FinancialSession } from './financial-session.js';
import { WagerTransactionMapper, type WagerTransactionRecord } from './wager-transaction-mapper.js';

export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly session: FinancialSession) {}

  async listByWalletId(walletId: string): Promise<readonly WagerTransaction[]> {
    const rows = await this.session.execute<WagerTransactionRecord[]>('SELECT * FROM wager_transactions WHERE wallet_id=? ORDER BY created_at,id', [walletId]);
    return rows.map(row => WagerTransactionMapper.toDomain(row));
  }

  async findProcessedReversal(referenceId: string): Promise<WagerTransaction | null> {
    return this.read("SELECT * FROM wager_transactions WHERE reference_transaction_id=? AND kind IN ('REFUND','ROLLBACK') AND status='PROCESSED'", [referenceId]);
  }

  async findProcessedRefund(referenceId: string): Promise<WagerTransaction | null> {
    return this.read("SELECT * FROM wager_transactions WHERE reference_transaction_id=? AND kind='REFUND' AND status='PROCESSED'", [referenceId]);
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.read('SELECT * FROM wager_transactions WHERE id = ?', [id]);
  }

  async findByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null> {
    return this.read('SELECT * FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?', [providerId, externalId]);
  }

  async findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | null> {
    return this.read('SELECT * FROM wager_transactions WHERE provider_id = ? AND idempotency_key = ?', [providerId, key]);
  }

  private async read(sql: string, parameters: string[]): Promise<WagerTransaction | null> {
    const [row] = await this.session.execute<WagerTransactionRecord[]>(sql, parameters);
    if (!row) return null;
    const transaction = WagerTransactionMapper.toDomain(row);
    this.session.attachTransaction(transaction);
    return transaction;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    this.session.attachTransaction(transaction);
    const r = WagerTransactionMapper.toRecord(transaction);
    await this.session.execute(`INSERT INTO wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount, currency, status, reference_external_transaction_id,
       reference_transaction_id, failure_code, created_at, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.id, r.provider_id, r.external_transaction_id, r.idempotency_key, r.payload_hash, r.wallet_id,
      r.player_id, r.round_id, r.game_id, r.kind, r.amount, r.currency, r.status,
      r.reference_external_transaction_id, r.reference_transaction_id, r.failure_code, r.created_at, r.processed_at]);
  }

  async updateLifecycle(transaction: WagerTransaction): Promise<void> {
    this.session.assertTransaction(transaction);
    const r = WagerTransactionMapper.toRecord(transaction);
    const updated = await this.session.execute<{ id: string }[]>(`UPDATE wager_transactions
      SET status = ?, reference_transaction_id = ?, failure_code = ?, processed_at = ? WHERE id = ? RETURNING id`,
    [r.status, r.reference_transaction_id, r.failure_code, r.processed_at, r.id]);
    if (updated.length !== 1) throw new Error('WagerTransaction no longer exists');
  }
}
