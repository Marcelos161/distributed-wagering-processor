import { AsyncLocalStorage } from 'node:async_hooks';
import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { FinancialRepositories, FinancialUnitOfWork } from '../../../application/ports/financial-persistence.js';
import { FinancialSession } from './financial-session.js';
import { createRepositories } from './create-repositories.js';
import { RetryableFinancialTransactionError } from '../../../application/errors/retryable-financial-transaction-error.js';

const activeBoundary = new AsyncLocalStorage<boolean>();

export class MikroFinancialUnitOfWork implements FinancialUnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (repositories: FinancialRepositories) => Promise<T>): Promise<T> {
    if (activeBoundary.getStore()) throw new Error('Nested financial units are not supported; share the current repositories');
    return activeBoundary.run(true, async () => {
      const fork = this.orm.em.fork({ clear: true, useContext: false });
      try { return await fork.transactional(async (em) => {
        const session = new FinancialSession(em);
        try { return await work(createRepositories(session)); }
        finally { session.close(); }
      }, { clear: true, isolationLevel: IsolationLevel.READ_COMMITTED });
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === '40001' || error.code === '40P01')) {
          throw new RetryableFinancialTransactionError(error.code, { cause: error });
        }
        throw error;
      }
    });
  }
}
