import { createHash } from 'node:crypto';
import type { WagerAdmissionRepository } from '../../../application/ports/wager-persistence.js';
import { FinancialSession } from './financial-session.js';

/** Length-delimited JSON tuple avoids ambiguous key concatenation; 64 bits are only lock addresses. */
function lockAddress(scope: string, provider: string, identity: string): bigint {
  return createHash('sha256').update(JSON.stringify(['dwp:wager:v1', scope, provider, identity])).digest().readBigInt64BE();
}
export class MikroWagerAdmissionRepository implements WagerAdmissionRepository {
  constructor(private readonly session: FinancialSession) {}
  async lock(providerId: string, idempotencyKey: string, externalTransactionId: string): Promise<void> {
    this.session.beforeWagerAdmission();
    const addresses = [...new Set([lockAddress('idempotency', providerId, idempotencyKey),
      lockAddress('external', providerId, externalTransactionId)])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const address of addresses) {
      await this.session.execute('SELECT pg_advisory_xact_lock(?::bigint)', [address.toString()]);
    }
  }
}
