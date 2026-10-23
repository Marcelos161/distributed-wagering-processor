import { readTimestamp } from './timestamp-mapper.js';
import { Wallet } from '../../../domain/wallet/wallet.js';
import { MoneyMapper, readVersion, writeVersion } from './money-mapper.js';

export interface WalletRecord {
  id: string; player_id: string; currency: string; balance: string; version: string;
  created_at: Date | string; updated_at: Date | string;
}

export class WalletMapper {
  static toDomain(row: WalletRecord): Wallet {
    return Wallet.rehydrate({ id: row.id, playerId: row.player_id, currency: row.currency,
      balance: MoneyMapper.toDomain(row.balance, row.currency), version: readVersion(row.version),
      createdAt: readTimestamp(row.created_at), updatedAt: readTimestamp(row.updated_at) });
  }

  static toRecord(wallet: Wallet): WalletRecord {
    return { id: wallet.id, player_id: wallet.playerId, currency: wallet.currency,
      balance: MoneyMapper.toRecord(wallet.balance), version: writeVersion(wallet.version),
      created_at: wallet.createdAt, updated_at: wallet.updatedAt };
  }
}
