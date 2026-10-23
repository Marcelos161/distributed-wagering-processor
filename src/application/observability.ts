import { AsyncLocalStorage } from 'node:async_hooks';
export const correlation = new AsyncLocalStorage<string>();
const counters = new Map<string, number>();
export function count(name: string, amount = 1): void { counters.set(name, (counters.get(name) ?? 0) + amount); }
export function metrics(): Readonly<Record<string, number>> { return Object.fromEntries(counters); }
export function record(operation: string, fields: { correlationId?: string; messageId?: string; eventId?: string; transactionId?: string;
  walletId?: string; providerId?: string; status: string; durationMs?: number }): void {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), operation, correlationId: correlation.getStore() ?? fields.correlationId ?? null,
    messageId: fields.messageId ?? null, eventId: fields.eventId ?? null, transactionId: fields.transactionId ?? null,
    walletId: fields.walletId ?? null, providerId: fields.providerId ?? null, status: fields.status, durationMs: fields.durationMs ?? null }) + '\n');
}
