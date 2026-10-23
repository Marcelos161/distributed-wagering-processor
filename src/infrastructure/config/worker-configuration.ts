import type { ReferenceRetryPolicy } from '../../application/wagering/resolve-pending-references.js';
export function positiveInteger(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, maximum = 2147483647): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error(`${name} exceeds its limit`);
  return value;
}
export function referencePolicy(env: Readonly<Record<string, string | undefined>>): ReferenceRetryPolicy {
  return { maxAttempts: positiveInteger(env, 'REFERENCE_MAX_ATTEMPTS', 300, 1000000),
    ttlMs: positiveInteger(env, 'REFERENCE_TTL_MS', 86400000),
    initialDelayMs: positiveInteger(env, 'REFERENCE_INITIAL_DELAY_MS', 1000),
    maxDelayMs: positiveInteger(env, 'REFERENCE_MAX_DELAY_MS', 300000) };
}
