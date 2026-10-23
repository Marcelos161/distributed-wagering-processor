import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000005 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION public.valid_wager_result(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE
        SET search_path=pg_catalog,public AS $fn$
        SELECT COALESCE(jsonb_typeof(p)='object' AND public.message_json_id(p->'transactionId')
          AND public.message_json_money(p->'balance')
          AND ((p->'balance') - ARRAY['amount','currency'])='{}'::jsonb
          AND p->'balance'->>'amount' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$'
          AND ((p->>'status'='PROCESSED' AND NOT p ? 'failureCode'
                AND (p-ARRAY['transactionId','status','balance'])='{}'::jsonb)
            OR (p->>'status' IN ('REJECTED','FAILED') AND public.message_json_id(p->'failureCode')
                AND (p-ARRAY['transactionId','status','balance','failureCode'])='{}'::jsonb)), false)
      $fn$;
      CREATE TABLE public.wager_transaction_results (
        transaction_id text PRIMARY KEY REFERENCES public.wager_transactions(id) ON DELETE RESTRICT,
        schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version=1),
        wallet_version bigint NOT NULL CHECK (wallet_version BETWEEN 1 AND 9007199254740991),
        response jsonb NOT NULL CHECK (public.valid_wager_result(response)),
        CHECK (response->>'transactionId'=transaction_id)
      );
      CREATE FUNCTION public.check_wager_result() RETURNS trigger LANGUAGE plpgsql
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
      CREATE TRIGGER wager_result_consistency BEFORE INSERT ON public.wager_transaction_results
        FOR EACH ROW EXECUTE FUNCTION public.check_wager_result();
      CREATE TRIGGER wager_results_immutable BEFORE UPDATE OR DELETE ON public.wager_transaction_results
        FOR EACH ROW EXECUTE FUNCTION public.reject_financial_mutation();
      CREATE TRIGGER wager_results_no_truncate BEFORE TRUNCATE ON public.wager_transaction_results
        FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_mutation();
      CREATE FUNCTION public.require_bet_result() RETURNS trigger LANGUAGE plpgsql
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
      CREATE CONSTRAINT TRIGGER bet_result_required AFTER INSERT OR UPDATE ON public.wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_bet_result();
      REVOKE ALL ON FUNCTION public.valid_wager_result(jsonb), public.check_wager_result(), public.require_bet_result() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.valid_wager_result(jsonb) TO wager_app;
      GRANT SELECT, INSERT ON public.wager_transaction_results TO wager_app;
    `);
  }
  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER bet_result_required ON public.wager_transactions;
      DROP TABLE public.wager_transaction_results;
      DROP FUNCTION public.require_bet_result(), public.check_wager_result(), public.valid_wager_result(jsonb);`);
  }
}
