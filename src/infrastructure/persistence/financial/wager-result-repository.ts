import type { WagerResultRepository } from '../../../application/ports/wager-persistence.js';
import type { WagerResultSnapshot } from '../../../application/wagering/wager-result.js';
import { FinancialSession } from './financial-session.js';
import { WagerResultMapper, type WagerResultRecord } from './wager-result-mapper.js';

export class MikroWagerResultRepository implements WagerResultRepository {
  constructor(private readonly session: FinancialSession) {}
  async findByTransactionId(id: string): Promise<WagerResultSnapshot | null> {
    const [row] = await this.session.execute<WagerResultRecord[]>(
      'SELECT transaction_id, schema_version, wallet_version::text, response FROM wager_transaction_results WHERE transaction_id=?', [id]);
    return row ? WagerResultMapper.toSnapshot(row) : null;
  }
  async insert(result: WagerResultSnapshot, walletVersion: number): Promise<void> {
    const row = WagerResultMapper.toRecord(result, walletVersion);
    await this.session.execute(`INSERT INTO wager_transaction_results (transaction_id,schema_version,wallet_version,response)
      VALUES (?,?,?,?::jsonb)`, [row.transaction_id, row.schema_version, row.wallet_version, JSON.stringify(row.response)]);
  }
}
