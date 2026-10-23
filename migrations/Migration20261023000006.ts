import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000006 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE public.wager_pending_receipts (
        transaction_id text PRIMARY KEY REFERENCES public.wager_transactions(id) ON DELETE RESTRICT,
        schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version=1),
        wallet_version bigint NOT NULL CHECK (wallet_version BETWEEN 1 AND 9007199254740991),
        response jsonb NOT NULL CHECK (
          (response->>'status'='PENDING_REFERENCE') IS TRUE
          AND public.valid_wager_result(response || '{"status":"PROCESSED"}'::jsonb)),
        CHECK (response->>'transactionId'=transaction_id)
      );
      CREATE FUNCTION public.check_wager_pending_receipt() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,public AS $fn$
      DECLARE operation public.wager_transactions%ROWTYPE; wallet public.wallets%ROWTYPE;
      BEGIN
        SELECT * INTO operation FROM public.wager_transactions WHERE id=NEW.transaction_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Receipt transaction does not exist' USING ERRCODE='23503'; END IF;
        IF operation.kind <> 'WIN' OR operation.status <> 'PENDING_REFERENCE'
          OR operation.currency IS DISTINCT FROM NEW.response->'balance'->>'currency' THEN
          RAISE EXCEPTION 'Receipt requires a pending WIN of the same currency' USING ERRCODE='23514';
        END IF;
        SELECT * INTO wallet FROM public.wallets WHERE id=operation.wallet_id FOR NO KEY UPDATE;
        IF wallet.version <> NEW.wallet_version OR wallet.balance IS DISTINCT FROM (NEW.response->'balance'->>'amount')::numeric THEN
          RAISE EXCEPTION 'Receipt must capture the locked wallet state' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER wager_pending_receipt_consistency BEFORE INSERT ON public.wager_pending_receipts
        FOR EACH ROW EXECUTE FUNCTION public.check_wager_pending_receipt();
      CREATE TRIGGER wager_pending_receipts_immutable BEFORE UPDATE OR DELETE ON public.wager_pending_receipts
        FOR EACH ROW EXECUTE FUNCTION public.reject_financial_mutation();
      CREATE TRIGGER wager_pending_receipts_no_truncate BEFORE TRUNCATE ON public.wager_pending_receipts
        FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_mutation();
      REVOKE ALL ON FUNCTION public.check_wager_pending_receipt() FROM PUBLIC;
      GRANT SELECT, INSERT ON public.wager_pending_receipts TO wager_app;
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
        IF operation.kind NOT IN ('BET','WIN','LOSS') OR operation.status NOT IN ('PROCESSED','REJECTED','FAILED')
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
        IF operation.kind IN ('BET','WIN','LOSS') AND operation.status IN ('PROCESSED','REJECTED','FAILED')
          AND NOT EXISTS (SELECT 1 FROM public.wager_transaction_results WHERE transaction_id=operation.id) THEN
          RAISE EXCEPTION 'Terminal wager requires its original result' USING ERRCODE='23514';
        END IF;
        IF operation.kind='WIN' AND operation.status='PENDING_REFERENCE'
          AND NOT EXISTS (SELECT 1 FROM public.wager_pending_receipts WHERE transaction_id=operation.id) THEN
          RAISE EXCEPTION 'Pending WIN requires its original receipt' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END $fn$;
    `);
  }
  override async down(): Promise<void> {
    this.addSql(`
      DO $guard$ BEGIN
        IF EXISTS (SELECT 1 FROM public.wager_pending_receipts)
          OR EXISTS (SELECT 1 FROM public.wager_transaction_results r JOIN public.wager_transactions t
            ON t.id=r.transaction_id WHERE t.kind IN ('WIN','LOSS')) THEN
          RAISE EXCEPTION 'Cannot downgrade with WIN/LOSS snapshots; preserve or archive data explicitly' USING ERRCODE='55000';
        END IF;
      END $guard$;
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
        IF operation.kind <> 'BET' OR operation.status NOT IN ('PROCESSED','REJECTED','FAILED')
          OR operation.status IS DISTINCT FROM NEW.response->>'status'
          OR operation.failure_code IS DISTINCT FROM NEW.response->>'failureCode'
          OR operation.currency IS DISTINCT FROM NEW.response->'balance'->>'currency' THEN
          RAISE EXCEPTION 'Result disagrees with terminal BET' USING ERRCODE='23514';
        END IF;
        SELECT * INTO wallet FROM public.wallets WHERE id=operation.wallet_id FOR NO KEY UPDATE;
        IF wallet.version <> NEW.wallet_version OR wallet.balance <> (NEW.response->'balance'->>'amount')::numeric THEN
          RAISE EXCEPTION 'Result must capture the locked wallet state' USING ERRCODE='23514';
        END IF;
        IF operation.status='PROCESSED' THEN
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
        IF operation.kind='BET' AND operation.status IN ('PROCESSED','REJECTED','FAILED')
          AND NOT EXISTS (SELECT 1 FROM public.wager_transaction_results WHERE transaction_id=operation.id) THEN
          RAISE EXCEPTION 'Terminal BET requires its original result' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END $fn$;

      DROP TABLE public.wager_pending_receipts;
      DROP FUNCTION public.check_wager_pending_receipt();
    `);
  }
}
