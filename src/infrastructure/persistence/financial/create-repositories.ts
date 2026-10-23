import { MikroInboxRepository } from './inbox-repository.js';
import { MikroOutboxRepository } from './outbox-repository.js';
import type { FinancialRepositories } from '../../../application/ports/financial-persistence.js';
import { FinancialSession } from './financial-session.js';
import { MikroWalletRepository } from './wallet-repository.js';
import { MikroWagerTransactionRepository } from './wager-transaction-repository.js';
import { MikroLedgerEntryRepository } from './ledger-entry-repository.js';

export function createRepositories(session: FinancialSession): FinancialRepositories {
  return Object.freeze({ inbox: new MikroInboxRepository(session), outbox: new MikroOutboxRepository(session), wallets: new MikroWalletRepository(session),
    transactions: new MikroWagerTransactionRepository(session), ledger: new MikroLedgerEntryRepository(session) });
}
