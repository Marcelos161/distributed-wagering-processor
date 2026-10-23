import { runWorker } from './infrastructure/workers/worker-runtime.js';
import { ResolvePendingReferences } from './application/wagering/resolve-pending-references.js';
import { referencePolicy } from './infrastructure/config/worker-configuration.js';
await runWorker('pending-reference-worker', ({ unit, process, clock }) => new ResolvePendingReferences(unit, process, clock, referencePolicy(globalThis.process.env))).catch(() => {
  process.stderr.write(JSON.stringify({ role: 'pending-reference-worker', status: 'startup_failed' }) + '\n');
  process.exitCode = 1;
});
