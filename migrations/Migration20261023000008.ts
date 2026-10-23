import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000008 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE UNIQUE INDEX wager_single_compensation_unique ON public.wager_transactions(reference_transaction_id)
        WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK');

      CREATE OR REPLACE FUNCTION public.check_wager_pending_receipt() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,public AS $fn$
      DECLARE operation public.wager_transactions%ROWTYPE; wallet public.wallets%ROWTYPE;
      BEGIN
        SELECT * INTO operation FROM public.wager_transactions WHERE id=NEW.transaction_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Receipt transaction does not exist' USING ERRCODE='23503'; END IF;
        IF operation.kind NOT IN ('WIN','REFUND','ROLLBACK') OR operation.status <> 'PENDING_REFERENCE'
          OR operation.currency IS DISTINCT FROM NEW.response->'balance'->>'currency' THEN
          RAISE EXCEPTION 'Receipt requires a pending WIN/REFUND/ROLLBACK of the same currency' USING ERRCODE='23514';
        END IF;
        SELECT * INTO wallet FROM public.wallets WHERE id=operation.wallet_id FOR NO KEY UPDATE;
        IF wallet.version <> NEW.wallet_version OR wallet.balance IS DISTINCT FROM (NEW.response->'balance'->>'amount')::numeric THEN
          RAISE EXCEPTION 'Receipt must capture the locked wallet state' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE OR REPLACE FUNCTION public.check_wager_result() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,public AS $fn$
      DECLARE operation public.wager_transactions%ROWTYPE; wallet public.wallets%ROWTYPE;
        entry public.wallet_ledger_entries%ROWTYPE;
      BEGIN
        IF NOT public.valid_wager_result(NEW.response) THEN
          RAISE EXCEPTION 'Invalid wager result shape' USING ERRCODE='23514';
        END IF;
        SELECT * INTO operation FROM public.wager_transactions WHERE id=NEW.transaction_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Result transaction does not exist' USING ERRCODE='23503'; END IF;
        IF operation.kind NOT IN ('BET','WIN','LOSS','REFUND','ROLLBACK') OR operation.status NOT IN ('PROCESSED','REJECTED','FAILED')
          OR operation.status IS DISTINCT FROM NEW.response->>'status'
          OR operation.failure_code IS DISTINCT FROM NEW.response->>'failureCode'
          OR operation.currency IS DISTINCT FROM NEW.response->'balance'->>'currency' THEN
          RAISE EXCEPTION 'Result disagrees with terminal wager' USING ERRCODE='23514';
        END IF;
        SELECT * INTO wallet FROM public.wallets WHERE id=operation.wallet_id FOR NO KEY UPDATE;
        IF wallet.version <> NEW.wallet_version OR wallet.balance <> (NEW.response->'balance'->>'amount')::numeric THEN
          RAISE EXCEPTION 'Result must capture the locked wallet state' USING ERRCODE='23514';
        END IF;
        IF operation.status='PROCESSED' AND operation.kind <> 'LOSS' THEN
          SELECT * INTO entry FROM public.wallet_ledger_entries WHERE transaction_id=operation.id;
          IF NOT FOUND OR entry.wallet_version <> NEW.wallet_version
            OR entry.balance_after <> (NEW.response->'balance'->>'amount')::numeric THEN
            RAISE EXCEPTION 'Processed result must match its ledger' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE OR REPLACE FUNCTION public.require_bet_result() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,public AS $fn$
      DECLARE operation public.wager_transactions%ROWTYPE;
      BEGIN
        SELECT * INTO operation FROM public.wager_transactions WHERE id=NEW.id;
        IF operation.kind IN ('BET','WIN','LOSS','REFUND','ROLLBACK') AND operation.status IN ('PROCESSED','REJECTED','FAILED')
          AND NOT EXISTS (SELECT 1 FROM public.wager_transaction_results WHERE transaction_id=operation.id) THEN
          RAISE EXCEPTION 'Terminal wager requires its original result' USING ERRCODE='23514';
        END IF;
        IF operation.kind IN ('WIN','REFUND','ROLLBACK') AND operation.status='PENDING_REFERENCE'
          AND NOT EXISTS (SELECT 1 FROM public.wager_pending_receipts WHERE transaction_id=operation.id) THEN
          RAISE EXCEPTION 'Pending WIN/REFUND/ROLLBACK requires its original receipt' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END $fn$;
    `);
  }
  override async down(): Promise<void> {
    this.addSql(`
      DO $guard$ BEGIN
        IF EXISTS (SELECT 1 FROM public.wager_transaction_results r JOIN public.wager_transactions t ON t.id=r.transaction_id WHERE t.kind='ROLLBACK')
          OR EXISTS (SELECT 1 FROM public.wager_pending_receipts r JOIN public.wager_transactions t ON t.id=r.transaction_id WHERE t.kind='ROLLBACK') THEN
          RAISE EXCEPTION 'Cannot downgrade with ROLLBACK responses' USING ERRCODE='55000';
        END IF;
      END $guard$;
      DROP INDEX public.wager_single_compensation_unique;

      CREATE OR REPLACE FUNCTION public.check_wager_pending_receipt() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,public AS $fn$
      DECLARE operation public.wager_transactions%ROWTYPE; wallet public.wallets%ROWTYPE;
      BEGIN
        SELECT * INTO operation FROM public.wager_transactions WHERE id=NEW.transaction_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Receipt transaction does not exist' USING ERRCODE='23503'; END IF;
        IF operation.kind NOT IN ('WIN','REFUND') OR operation.status <> 'PENDING_REFERENCE'
          OR operation.currency IS DISTINCT FROM NEW.response->'balance'->>'currency' THEN
          RAISE EXCEPTION 'Receipt requires a pending WIN/REFUND of the same currency' USING ERRCODE='23514';
        END IF;
        SELECT * INTO wallet FROM public.wallets WHERE id=operation.wallet_id FOR NO KEY UPDATE;
        IF wallet.version <> NEW.wallet_version OR wallet.balance IS DISTINCT FROM (NEW.response->'balance'->>'amount')::numeric THEN
          RAISE EXCEPTION 'Receipt must capture the locked wallet state' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE OR REPLACE FUNCTION public.check_wager_result() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,public AS $fn$
      DECLARE operation public.wager_transactions%ROWTYPE; wallet public.wallets%ROWTYPE;
        entry public.wallet_ledger_entries%ROWTYPE;
      BEGIN
        IF NOT public.valid_wager_result(NEW.response) THEN
          RAISE EXCEPTION 'Invalid wager result shape' USING ERRCODE='23514';
        END IF;
        SELECT * INTO operation FROM public.wager_transactions WHERE id=NEW.transaction_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Result transaction does not exist' USING ERRCODE='23503'; END IF;
        IF operation.kind NOT IN ('BET','WIN','LOSS','REFUND') OR operation.status NOT IN ('PROCESSED','REJECTED','FAILED')
          OR operation.status IS DISTINCT FROM NEW.response->>'status'
          OR operation.failure_code IS DISTINCT FROM NEW.response->>'failureCode'
          OR operation.currency IS DISTINCT FROM NEW.response->'balance'->>'currency' THEN
          RAISE EXCEPTION 'Result disagrees with terminal wager' USING ERRCODE='23514';
        END IF;
        SELECT * INTO wallet FROM public.wallets WHERE id=operation.wallet_id FOR NO KEY UPDATE;
        IF wallet.version <> NEW.wallet_version OR wallet.balance <> (NEW.response->'balance'->>'amount')::numeric THEN
          RAISE EXCEPTION 'Result must capture the locked wallet state' USING ERRCODE='23514';
        END IF;
        IF operation.status='PROCESSED' AND operation.kind <> 'LOSS' THEN
          SELECT * INTO entry FROM public.wallet_ledger_entries WHERE transaction_id=operation.id;
          IF NOT FOUND OR entry.wallet_version <> NEW.wallet_version
            OR entry.balance_after <> (NEW.response->'balance'->>'amount')::numeric THEN
            RAISE EXCEPTION 'Processed result must match its ledger' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE OR REPLACE FUNCTION public.require_bet_result() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,public AS $fn$
      DECLARE operation public.wager_transactions%ROWTYPE;
      BEGIN
        SELECT * INTO operation FROM public.wager_transactions WHERE id=NEW.id;
        IF operation.kind IN ('BET','WIN','LOSS','REFUND') AND operation.status IN ('PROCESSED','REJECTED','FAILED')
          AND NOT EXISTS (SELECT 1 FROM public.wager_transaction_results WHERE transaction_id=operation.id) THEN
          RAISE EXCEPTION 'Terminal wager requires its original result' USING ERRCODE='23514';
        END IF;
        IF operation.kind IN ('WIN','REFUND') AND operation.status='PENDING_REFERENCE'
          AND NOT EXISTS (SELECT 1 FROM public.wager_pending_receipts WHERE transaction_id=operation.id) THEN
          RAISE EXCEPTION 'Pending WIN/REFUND requires its original receipt' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END $fn$;
    `);
  }
}
