import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Money } from '../src/domain/money/money.js';
import { LedgerDirection } from '../src/domain/wallet/wallet-ledger-entry.js';
import { FailureCode } from '../src/domain/wagering/failure-code.js';
import { InvalidTransactionStateError, WagerTransactionError, type WagerTransactionErrorCode } from '../src/domain/wagering/wager-transaction-error.js';
import {
  WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status,
  type CreateWagerTransactionProps, type CreateOpeningTransactionProps, type WagerTransactionState,
} from '../src/domain/wagering/wager-transaction.js';

function money(amount = '25.00', currency = 'BRL'): Money { return Money.from({ amount, currency }); }

function props(patch: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return { id: 'tx-1', providerId: 'provider-a', externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1', payloadHash: 'opaque-hash', walletId: 'wallet-1',
    playerId: 'player-1', roundId: 'round-1', gameId: 'game-1', kind: Kind.Bet,
    money: money(), createdAt: new Date('2026-10-22T12:00:00Z'), ...patch };
}

function state(patch: Partial<WagerTransactionState> = {}): WagerTransactionState {
  return { ...props(), status: Status.Pending, ...patch };
}

function target(kind = Kind.Bet, patch: Partial<WagerTransactionState> = {}): WagerTransaction {
  return WagerTransaction.rehydrate(state({ id: 'reference-id', externalTransactionId: 'reference-ext',
    kind, money: kind === Kind.Loss ? money('0.00') : money(), status: Status.Processed,
    processedAt: new Date('2026-10-22T12:01:00Z'),
    ...([Kind.Refund, Kind.Rollback].includes(kind)
      ? { referenceExternalTransactionId: 'earlier-ext', referenceTransactionId: 'earlier-id' } : {}), ...patch }));
}

function dependent(kind = Kind.Refund, patch: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'reference-ext', ...patch }));
}

function snapshot(tx: WagerTransaction) {
  return { ...tx, money: tx.money.toJSON(), createdAt: tx.createdAt.toISOString(), status: tx.status,
    referenceTransactionId: tx.referenceTransactionId, failureCode: tx.failureCode,
    processedAt: tx.processedAt?.toISOString() };
}

function expectCode(run: () => unknown, code: WagerTransactionErrorCode): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(WagerTransactionError);
  expect(caught).toHaveProperty('code', code);
  if (code === 'INVALID_TRANSACTION_STATE') expect(caught).toBeInstanceOf(InvalidTransactionStateError);
}

for (const kind of Object.values(Kind)) {
  test(`creates ${kind} as PENDING with preserved identity, Money and no outcome`, () => {
    const input = props({ kind, money: kind === Kind.Loss ? money('0.00') : money(),
      ...([Kind.Refund, Kind.Rollback].includes(kind) ? { referenceExternalTransactionId: 'reference-ext' } : {}) });
    const tx = kind === Kind.Opening ? WagerTransaction.createOpening(input) : WagerTransaction.create(input);
    for (const field of ['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash',
      'walletId', 'playerId', 'roundId', 'gameId', 'kind', 'money', 'referenceExternalTransactionId'] as const) {
      expect(tx[field]).toBe(input[field]);
    }
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.requiresReference()).toBe([Kind.Refund, Kind.Rollback].includes(kind));
    expect(tx.affectsBalance()).toBe(kind !== Kind.Loss);
  });

  test(`${kind} enforces the approved amount policy including internal negative Money`, () => {
    for (const value of [money('0.00'), money('0.01'), money().negate()]) {
      const input = props({ kind, money: value,
        ...([Kind.Refund, Kind.Rollback].includes(kind) ? { referenceExternalTransactionId: 'reference-ext' } : {}) });
      const run = () => kind === Kind.Opening ? WagerTransaction.createOpening(input) : WagerTransaction.create(input);
      if (kind === Kind.Loss ? value.isZero() : value.isPositive()) expect(run().money).toBe(value);
      else expectCode(run, 'INVALID_AMOUNT');
    }
  });
}

test('external creation refuses OPENING while the explicit internal factory works', () => {
  expectCode(() => WagerTransaction.create(props({ kind: Kind.Opening })), 'INTERNAL_ONLY_KIND');
  const { kind: _kind, ...input } = props();
  const opening = WagerTransaction.createOpening(input);
  expect(opening.kind).toBe(Kind.Opening);
  expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  opening.markProcessed(undefined, new Date(0));
  expect(opening.status).toBe(Status.Processed);
  for (const patch of [{ kind: Kind.Bet }, { referenceExternalTransactionId: 'unexpected' }]) {
    expectCode(() => WagerTransaction.createOpening({ ...input, ...patch } as CreateOpeningTransactionProps), 'INTERNAL_ONLY_KIND');
  }
});

test('create strips untrusted lifecycle fields and never admits a terminal snapshot', () => {
  const tx = WagerTransaction.create(state({ status: Status.Failed,
    failureCode: FailureCode.PermanentInfrastructureFailure, processedAt: new Date(0), referenceTransactionId: 'injected' }));
  expect(tx.status).toBe(Status.Pending);
  expect(tx.failureCode).toBeUndefined();
  expect(tx.processedAt).toBeUndefined();
  expect(tx.referenceTransactionId).toBeUndefined();
});

for (const initial of [Status.Pending, Status.PendingReference]) {
  for (const outcome of [Status.Processed, Status.Rejected, Status.Failed]) {
    test(`${initial} transitions to ${outcome} with the correct outcome fields`, () => {
      const tx = dependent();
      if (initial === Status.PendingReference) tx.markPendingReference();
      if (outcome === Status.Processed) tx.markProcessed(target(), new Date(0));
      else if (outcome === Status.Rejected) tx.reject(FailureCode.InvalidReference);
      else tx.fail(FailureCode.PermanentInfrastructureFailure);
      expect(tx.status).toBe(outcome);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.referenceTransactionId).toBe(outcome === Status.Processed ? 'reference-id' : undefined);
      expect(tx.processedAt?.getTime()).toBe(outcome === Status.Processed ? 0 : undefined);
      expect(tx.failureCode).toBe(outcome === Status.Processed ? undefined : outcome === Status.Rejected
        ? FailureCode.InvalidReference : FailureCode.PermanentInfrastructureFailure);
    });
  }
}

test('waiting for a reference is explicit, requires a reference and cannot repeat', () => {
  const bet = WagerTransaction.create(props());
  expectCode(() => bet.markPendingReference(), 'INVALID_TRANSACTION_STATE');
  expect(bet.status).toBe(Status.Pending);
  const tx = dependent(Kind.Win);
  tx.markPendingReference();
  expect(tx.status).toBe(Status.PendingReference);
  expect(tx.isTerminal()).toBe(false);
  const before = snapshot(tx);
  expectCode(() => tx.markPendingReference(), 'INVALID_TRANSACTION_STATE');
  expect(snapshot(tx)).toEqual(before);
});

for (const terminal of [Status.Processed, Status.Rejected, Status.Failed]) {
  test(`${terminal} refuses every transition including reprocessing, preserving the entire snapshot`, () => {
    const tx = dependent();
    if (terminal === Status.Processed) tx.markProcessed(target(), new Date(0));
    else if (terminal === Status.Rejected) tx.reject(FailureCode.InvalidReference);
    else tx.fail(FailureCode.PermanentInfrastructureFailure);
    const before = snapshot(tx);
    for (const attempt of [() => tx.markProcessed(target(), new Date()), () => tx.markPendingReference(),
      () => tx.reject(FailureCode.DomainRuleViolation), () => tx.fail(FailureCode.PermanentInfrastructureFailure),
      () => tx.markProcessed(undefined, new Date('invalid')), () => tx.reject('unknown' as FailureCode)]) {
      expectCode(attempt, 'INVALID_TRANSACTION_STATE');
      expect(snapshot(tx)).toEqual(before);
    }
    expect(tx.affectsBalance()).toBe(terminal === Status.Processed);
    if (terminal !== Status.Processed) expect(tx.ledgerDirectionFor()).toBeNull();
  });
}

test.each([Kind.Refund, Kind.Rollback])('%s requires an external reference at creation', (kind) => {
  expectCode(() => WagerTransaction.create(props({ kind })), 'REFERENCE_REQUIRED');
});

test.each([Kind.Bet, Kind.Loss])('%s refuses an unrelated external reference', (kind) => {
  expectCode(() => dependent(kind, { money: kind === Kind.Loss ? money('0.00') : money() }), 'INVALID_REFERENCE');
});

test.each([Kind.Win, Kind.Refund, Kind.Rollback])('%s rejects self references by external ID', (kind) => {
  expectCode(() => dependent(kind, { referenceExternalTransactionId: 'ext-1' }), 'INVALID_REFERENCE');
});

for (const kind of [Kind.Win, Kind.Refund, Kind.Rollback]) {
  test(`${kind} cannot process or calculate direction without its supplied external reference resolved`, () => {
    const tx = dependent(kind);
    const before = snapshot(tx);
    expectCode(() => tx.markProcessed(undefined, new Date(0)), 'REFERENCE_REQUIRED');
    expectCode(() => tx.ledgerDirectionFor(), 'REFERENCE_REQUIRED');
    expect(snapshot(tx)).toEqual(before);
  });

  test.each(['providerId', 'playerId', 'walletId', 'roundId', 'externalTransactionId'] as const)
  (`${kind} rejects a reference with different %s without mutation`, (field) => {
    const tx = dependent(kind);
    const before = snapshot(tx);
    const reference = target(Kind.Bet, { [field]: 'different' });
    expectCode(() => tx.markProcessed(reference, new Date(0)), 'INVALID_REFERENCE');
    expectCode(() => tx.ledgerDirectionFor(reference), 'INVALID_REFERENCE');
    expect(snapshot(tx)).toEqual(before);
  });

  test(`${kind} rejects currency mismatch, own internal ID and a DTO masquerading as reference`, () => {
    const tx = dependent(kind);
    for (const reference of [target(Kind.Bet, { money: money('25.00', 'USD') }),
      target(Kind.Bet, { id: tx.id }), {} as WagerTransaction, null as unknown as WagerTransaction]) {
      expectCode(() => tx.markProcessed(reference, new Date(0)), 'INVALID_REFERENCE');
      expect(tx.status).toBe(Status.Pending);
    }
  });
}

test.each([Status.Pending, Status.PendingReference, Status.Rejected, Status.Failed])
('reference in %s cannot be consumed and does not automatically reject the dependent operation', (status) => {
  const reference = target(Kind.Refund, { status, processedAt: undefined, referenceTransactionId: undefined,
    failureCode: status === Status.Rejected ? FailureCode.InvalidReference
      : status === Status.Failed ? FailureCode.PermanentInfrastructureFailure : undefined });
  const tx = dependent(Kind.Rollback);
  expectCode(() => tx.markProcessed(reference, new Date(0)), reference.isTerminal() ? 'INVALID_REFERENCE' : 'REFERENCE_NOT_PROCESSED');
  expect(tx.status).toBe(Status.Pending);
  expect(tx.failureCode).toBeUndefined();
});

for (const kind of [Kind.Win, Kind.Refund, Kind.Rollback]) {
  test.each(Object.values(Kind))(`${kind} validates target kind %s`, (referenceKind) => {
    const reference = target(referenceKind);
    const tx = dependent(kind);
    const allowed = referenceKind === Kind.Bet || (kind === Kind.Rollback && [Kind.Win, Kind.Refund].includes(referenceKind));
    if (allowed) {
      tx.markProcessed(reference, new Date(0));
      expect(tx.referenceTransactionId).toBe(reference.id);
    } else expectCode(() => tx.markProcessed(reference, new Date(0)), 'INVALID_REFERENCE');
  });
}

test.each([Kind.Refund, Kind.Rollback])('%s accepts only the full amount, including exact cents and large amounts', (kind) => {
  for (const amount of ['24.99', '25.01']) {
    expectCode(() => dependent(kind, { money: money(amount) }).markProcessed(target(), new Date(0)), 'INVALID_REFERENCE');
  }
  for (const amount of ['0.01', `${'9'.repeat(100)}.99`]) {
    const tx = dependent(kind, { money: money(amount) });
    tx.markProcessed(target(Kind.Bet, { money: money(amount) }), new Date(0));
    expect(tx.money.toJSON().amount).toBe(amount);
  }
});

test('WIN may have no reference or a processed BET with a different prize; gameId is not a reference scope', () => {
  const without = WagerTransaction.create(props({ kind: Kind.Win }));
  expect(without.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  without.markProcessed(undefined, new Date(0));
  const withReference = dependent(Kind.Win, { money: money('99.99'), gameId: 'another-game' });
  expect(withReference.requiresReference()).toBe(false);
  withReference.markProcessed(target(), new Date(0));
  expect(withReference.referenceTransactionId).toBe('reference-id');
});

test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s without an external ID refuses an unexpected reference during processing', (kind) => {
  const tx = WagerTransaction.create(props({ kind, money: kind === Kind.Loss ? money('0.00') : money() }));
  expectCode(() => tx.markProcessed(target(), new Date(0)), 'INVALID_REFERENCE');
  expect(tx.status).toBe(Status.Pending);
});

test('LOSS records PROCESSED without financial effect or ledger direction', () => {
  const tx = WagerTransaction.create(props({ kind: Kind.Loss, money: money('0.00') }));
  expect(tx.ledgerDirectionFor()).toBeNull();
  tx.markProcessed(undefined, new Date(0));
  expect(tx.status).toBe(Status.Processed);
  expect(tx.affectsBalance()).toBe(false);
  expect(tx.ledgerDirectionFor()).toBeNull();
  expect(tx.referenceTransactionId).toBeUndefined();
});

test.each([
  { kind: Kind.Bet, reference: undefined, direction: LedgerDirection.Debit },
  { kind: Kind.Win, reference: undefined, direction: LedgerDirection.Credit },
  { kind: Kind.Refund, reference: Kind.Bet, direction: LedgerDirection.Credit },
  { kind: Kind.Rollback, reference: Kind.Bet, direction: LedgerDirection.Credit },
  { kind: Kind.Rollback, reference: Kind.Win, direction: LedgerDirection.Debit },
  { kind: Kind.Rollback, reference: Kind.Refund, direction: LedgerDirection.Debit },
])('$kind with reference $reference has direction $direction before and after processing', ({ kind, reference, direction }) => {
  const tx = reference === undefined ? WagerTransaction.create(props({ kind })) : dependent(kind);
  const ref = reference === undefined ? undefined : target(reference);
  expect(tx.ledgerDirectionFor(ref)).toBe(direction);
  tx.markProcessed(ref, new Date(0));
  expect(tx.ledgerDirectionFor(ref)).toBe(direction);
  if (ref) expectCode(() => tx.ledgerDirectionFor(target(reference, { id: 'other-internal-id' })), 'INVALID_REFERENCE');
});

const rejections = [
  { kind: Kind.Bet, code: FailureCode.InsufficientFunds },
  { kind: Kind.Rollback, code: FailureCode.ReversalInsufficientFunds },
  { kind: Kind.Refund, code: FailureCode.ReferenceNotFound },
  { kind: Kind.Win, code: FailureCode.InvalidReference },
  { kind: Kind.Refund, code: FailureCode.DuplicateReversal },
  { kind: Kind.Rollback, code: FailureCode.DuplicateReversal },
  { kind: Kind.Loss, code: FailureCode.DomainRuleViolation },
];
test.each(rejections)('$kind persists the stable rejection $code and has no ledger effect', ({ kind, code }) => {
  const tx = [Kind.Win, Kind.Refund, Kind.Rollback].includes(kind) ? dependent(kind)
    : WagerTransaction.create(props({ kind, money: kind === Kind.Loss ? money('0.00') : money() }));
  tx.reject(code);
  expect(tx.failureCode).toBe(code);
  expect(tx.status).toBe(Status.Rejected);
  expect(tx.affectsBalance()).toBe(false);
  expect(tx.ledgerDirectionFor()).toBeNull();
});

test.each(Object.values(FailureCode))('fail accepts only infrastructure code, not %s business outcomes', (code) => {
  const tx = WagerTransaction.create(props());
  if (code === FailureCode.PermanentInfrastructureFailure) {
    tx.fail(code);
    expect(tx.failureCode).toBe(code);
  } else {
    expectCode(() => tx.fail(code), 'INVALID_FAILURE_CODE');
    expect(tx.status).toBe(Status.Pending);
  }
});

test('reject rejects inappropriate kinds, API conflicts, infra codes and unknown codes without mutation', () => {
  for (const code of [FailureCode.ReversalInsufficientFunds, FailureCode.ReferenceNotFound, FailureCode.InvalidReference,
    FailureCode.DuplicateReversal, FailureCode.PermanentInfrastructureFailure, FailureCode.IdempotencyConflict, 'unknown' as FailureCode]) {
    const tx = WagerTransaction.create(props());
    const before = snapshot(tx);
    expectCode(() => tx.reject(code), 'INVALID_FAILURE_CODE');
    expect(snapshot(tx)).toEqual(before);
  }
  expectCode(() => dependent().reject(FailureCode.InsufficientFunds), 'INVALID_FAILURE_CODE');
  expectCode(() => dependent().reject(FailureCode.ReversalInsufficientFunds), 'INVALID_FAILURE_CODE');
});

test('hash comparison is exact and never mutates the original transaction on conflict', () => {
  const tx = WagerTransaction.create(props());
  const before = snapshot(tx);
  expect(tx.matchesPayload('opaque-hash')).toBe(true);
  for (const hash of ['OPAQUE-HASH', 'opaque-hash ', '', 'different']) expect(tx.matchesPayload(hash)).toBe(false);
  expect(snapshot(tx)).toEqual(before);
  expect(String(FailureCode.IdempotencyConflict)).toBe('IDEMPOTENCY_CONFLICT');
});

for (const status of Object.values(Status)) {
  test(`rehydrate restores ${status} without replaying reference resolution or transitions`, () => {
    const input = state({ kind: Kind.Refund, referenceExternalTransactionId: 'not-loaded', status,
      ...(status === Status.Processed ? { referenceTransactionId: 'stored-id', processedAt: new Date(0) } : {}),
      ...(status === Status.Rejected ? { failureCode: FailureCode.ReferenceNotFound } : {}),
      ...(status === Status.Failed ? { failureCode: FailureCode.PermanentInfrastructureFailure } : {}) });
    const tx = WagerTransaction.rehydrate(input);
    expect(tx.status).toBe(status);
    expect(tx.referenceTransactionId).toBe(input.referenceTransactionId);
    expect(tx.failureCode).toBe(input.failureCode);
    expect(tx.processedAt?.getTime()).toBe(input.processedAt?.getTime());
    if (!tx.isTerminal()) {
      tx.markProcessed(target(Kind.Bet, { externalTransactionId: 'not-loaded' }), new Date(0));
      expect(tx.status).toBe(Status.Processed);
    }
  });
}

const malformedSnapshots: Array<{ patch: Partial<WagerTransactionState>; code: WagerTransactionErrorCode }> = [
  { patch: { status: 'UNKNOWN' as Status }, code: 'INVALID_STATE' },
  { patch: { status: Status.Processed }, code: 'INVALID_STATE' },
  { patch: { status: Status.PendingReference }, code: 'INVALID_STATE' },
  { patch: { processedAt: new Date(0) }, code: 'INVALID_STATE' },
  { patch: { referenceTransactionId: 'ref' }, code: 'INVALID_STATE' },
  { patch: { failureCode: FailureCode.DomainRuleViolation }, code: 'INVALID_FAILURE_CODE' },
  { patch: { status: Status.Rejected }, code: 'INVALID_FAILURE_CODE' },
  { patch: { status: Status.Failed }, code: 'INVALID_FAILURE_CODE' },
  { patch: { status: Status.Rejected, failureCode: FailureCode.PermanentInfrastructureFailure }, code: 'INVALID_FAILURE_CODE' },
  { patch: { status: Status.Failed, failureCode: FailureCode.InsufficientFunds }, code: 'INVALID_FAILURE_CODE' },
  { patch: { status: Status.Processed, processedAt: new Date(0), referenceTransactionId: 'orphan' }, code: 'INVALID_STATE' },
  { patch: { kind: Kind.Refund, referenceExternalTransactionId: 'ref', status: Status.Processed, processedAt: new Date(0) }, code: 'INVALID_STATE' },
  { patch: { kind: Kind.Refund, referenceExternalTransactionId: 'ref', referenceTransactionId: 'tx-1' }, code: 'INVALID_REFERENCE' },
];
test.each(malformedSnapshots)('rehydrate rejects incoherent lifecycle snapshot %#', ({ patch, code }) => {
  expectCode(() => WagerTransaction.rehydrate(state(patch)), code);
});

for (const factory of ['create', 'rehydrate'] as const) {
  test.each(['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId',
    'playerId', 'roundId', 'gameId', 'referenceExternalTransactionId'] as const)
  (`${factory} refuses malformed identifier/hash %s without normalization`, (field) => {
    for (const invalid of ['', ' ', ' leading', 'trailing ', 'two words', '\u0000', 'x\n', 123, null, ...(field === 'referenceExternalTransactionId' ? [] : [undefined])]) {
      expectCode(() => WagerTransaction[factory]({ ...state(), [field]: invalid } as WagerTransactionState), 'INVALID_IDENTIFIER');
    }
  });

  test(`${factory} validates object, kind, Money and timestamps at runtime`, () => {
    for (const input of [null, undefined, [], 'input']) {
      expectCode(() => WagerTransaction[factory](input as unknown as WagerTransactionState), 'INVALID_STATE');
    }
    expectCode(() => WagerTransaction[factory](state({ kind: 'OTHER' as Kind })), 'INVALID_KIND');
    for (const value of [undefined, null, { amount: '1.00', currency: 'BRL' }]) {
      expectCode(() => WagerTransaction[factory](state({ money: value as unknown as Money })), 'INVALID_MONEY');
    }
    for (const date of [new Date('invalid'), '2026-10-22', null, undefined]) {
      expectCode(() => WagerTransaction[factory](state({ createdAt: date as Date })), 'INVALID_DATE');
    }
  });
}

test('processing and rehydration reject invalid processed dates without partial changes', () => {
  for (const date of [new Date('invalid'), '2026-10-22', null, undefined]) {
    const tx = dependent();
    const before = snapshot(tx);
    expectCode(() => tx.markProcessed(target(), date as Date), 'INVALID_DATE');
    expect(snapshot(tx)).toEqual(before);
    if (date !== undefined) expectCode(() => WagerTransaction.rehydrate(state({ status: Status.Processed, processedAt: date as Date })), 'INVALID_DATE');
  }
});

test('all fields and dates resist assignment, input mutation and getter mutation', () => {
  const input = props();
  const tx = WagerTransaction.create(input);
  const before = snapshot(tx);
  for (const key of [...Object.keys(input), 'status', 'failureCode', 'referenceTransactionId', 'processedAt']) {
    expect(Reflect.set(tx, key, 'tampered')).toBe(false);
  }
  expect(() => Object.defineProperty(tx, 'status', { value: Status.Failed })).toThrow(TypeError);
  input.createdAt.setTime(0);
  tx.createdAt.setTime(0);
  tx.money.toJSON().amount = '999.00';
  expect(snapshot(tx)).toEqual(before);
  const at = new Date('2026-10-22T12:02:00Z');
  tx.markProcessed(undefined, at);
  at.setTime(0);
  tx.processedAt!.setTime(0);
  expect(tx.processedAt!.toISOString()).toBe('2026-10-22T12:02:00.000Z');
  const saved = state({ status: Status.Processed, processedAt: new Date(0) });
  const restored = WagerTransaction.rehydrate(saved);
  saved.processedAt!.setTime(1000);
  expect(restored.processedAt!.getTime()).toBe(0);
  expect(Object.isFrozen(tx)).toBe(true);
});

test('two independent reversals remain locally valid: persistent uniqueness is a future database responsibility', () => {
  const a = dependent();
  const b = dependent(Kind.Refund, { id: 'tx-2', externalTransactionId: 'ext-2', idempotencyKey: 'another-key' });
  a.markProcessed(target(), new Date(0));
  b.markProcessed(target(), new Date(0));
  expect(a.status).toBe(Status.Processed);
  expect(b.status).toBe(Status.Processed);
});

test('direct construction cannot bypass factories even from JavaScript', () => {
  expect(() => Reflect.construct(WagerTransaction, [state()])).toThrow(TypeError);
  expect(() => Reflect.construct(WagerTransaction, [state(), Symbol('WagerTransaction construction')])).toThrow(TypeError);
});

test('wager dependency graph uses only domain files and decimal.js, without NestJS or MikroORM', async () => {
  const root = fileURLToPath(new URL('../src/domain/', import.meta.url));
  const pending = [resolve(root, 'wagering/wager-transaction.ts')];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    expect(file.startsWith(root)).toBe(true);
    for (const dependency of ts.preProcessFile(await readFile(file, 'utf8')).importedFiles) {
      if (dependency.fileName.startsWith('.')) pending.push(resolve(dirname(file), dependency.fileName.replace(/\.js$/, '.ts')));
      else expect(dependency.fileName).toBe('decimal.js');
    }
  }
  expect(visited.size).toBeGreaterThan(1);
});

test('a refund arriving before its BET waits and can complete once the same reference is processed', () => {
  const bet = WagerTransaction.create(props({ id: 'reference-id', externalTransactionId: 'reference-ext' }));
  const refund = dependent();
  expectCode(() => refund.markProcessed(bet, new Date(0)), 'REFERENCE_NOT_PROCESSED');
  refund.markPendingReference();
  expect(refund.status).toBe(Status.PendingReference);
  bet.markProcessed(undefined, new Date(0));
  refund.markProcessed(bet, new Date(1));
  expect(refund.status).toBe(Status.Processed);
  expect(refund.referenceTransactionId).toBe(bet.id);
  expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
});

test('the internal opening factory validates input and initializes its own lifecycle', () => {
  for (const input of [undefined, null, [], 'opening']) {
    expectCode(() => WagerTransaction.createOpening(input as unknown as CreateOpeningTransactionProps), 'INVALID_STATE');
  }
  const opening = WagerTransaction.createOpening(state({ kind: Kind.Opening, status: Status.Failed,
    failureCode: FailureCode.PermanentInfrastructureFailure, referenceTransactionId: 'injected', processedAt: new Date(0) }));
  expect(opening.status).toBe(Status.Pending);
  expect(opening.failureCode).toBeUndefined();
  expect(opening.referenceTransactionId).toBeUndefined();
  expect(opening.processedAt).toBeUndefined();
});
