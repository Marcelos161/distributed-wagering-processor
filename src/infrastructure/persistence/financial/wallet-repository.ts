import type { WalletRepository } from '../../../application/ports/financial-persistence.js';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import { FinancialSession } from './financial-session.js';
import { WalletMapper, type WalletRecord } from './wallet-mapper.js';

const columns = 'id, player_id, currency, balance::text, version::text, created_at, updated_at';

export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly session: FinancialSession) {}

  async findById(id: string): Promise<Wallet | null> {
    return this.read(`SELECT ${columns} FROM wallets WHERE id = ?`, [id], false);
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    return this.read(`SELECT ${columns} FROM wallets WHERE player_id = ? AND currency = ?`, [playerId, currency], false);
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    this.session.beforeLock(id);
    return this.read(`SELECT ${columns} FROM wallets WHERE id = ? FOR NO KEY UPDATE`, [id], true);
  }

  private async read(sql: string, parameters: string[], locked: boolean): Promise<Wallet | null> {
    const [row] = await this.session.execute<WalletRecord[]>(sql, parameters);
    if (!row) return null;
    const wallet = WalletMapper.toDomain(row);
    this.session.attachWallet(wallet, locked);
    return wallet;
  }

  async insert(wallet: Wallet): Promise<void> {
    this.session.attachWallet(wallet, true);
    const row = WalletMapper.toRecord(wallet);
    await this.session.execute('INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.player_id, row.currency, row.balance, row.version, row.created_at, row.updated_at]);
  }

  async save(wallet: Wallet): Promise<void> {
    const previousVersion = this.session.versionBeforeSave(wallet);
    const row = WalletMapper.toRecord(wallet);
    const updated = await this.session.execute<{ id: string }[]>(
      'UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? RETURNING id',
      [row.balance, row.version, row.updated_at, row.id, String(previousVersion)]);
    if (updated.length !== 1) throw new Error('Wallet version changed; reload before another operation');
    this.session.saved(wallet);
  }
}
