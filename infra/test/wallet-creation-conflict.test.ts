import { expect, test } from 'bun:test';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { Money } from '../../src/domain/money/money.js';
import { WalletAlreadyExistsError } from '../../src/application/errors/wallet-already-exists-error.js';
import { withMessagingDatabase } from './messaging-support.js';

test('only the player and currency constraint becomes a wallet creation conflict', async () => {
  await withMessagingDatabase(async ({ unit, app }) => {
    const make = (id: string, playerId: string) => Wallet.open({ id, playerId, initialBalance: Money.zero('BRL'), at: new Date() }).wallet;
    await unit.run(repos => repos.wallets.insert(make('first', 'player')));
    let conflict: unknown;
    try { await unit.run(repos => repos.wallets.insert(make('second', 'player'))); } catch (error) { conflict = error; }
    expect(conflict).toBeInstanceOf(WalletAlreadyExistsError);
    expect(conflict).toHaveProperty('code', 'WALLET_ALREADY_EXISTS');
    expect(conflict).toHaveProperty('cause.constraint', 'wallets_player_currency_unique');
    await expect(unit.run(repos => repos.wallets.insert(make('first', 'other'))))
      .rejects.toHaveProperty('constraint', 'wallets_pkey');
    expect((await app`SELECT count(*)::text AS n FROM wallets`)[0].n).toBe('1');
  });
}, 20_000);
