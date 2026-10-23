import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000003 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      -- Do not silently bless unbacked balances written between migration increments.
      DO $guard$ BEGIN
        IF EXISTS (SELECT 1 FROM public.wallets WHERE balance <> 0 OR version <> 1)
          OR EXISTS (SELECT 1 FROM public.wager_transactions WHERE status='PROCESSED' AND kind <> 'LOSS') THEN
          RAISE EXCEPTION 'Existing financial effects require an explicit history migration' USING ERRCODE='23514';
        END IF;
      END $guard$;
      CREATE TABLE public.wallet_ledger_entries (
        id text PRIMARY KEY CHECK (id <> '' AND id !~ '[[:space:][:cntrl:]]'),
        wallet_id text NOT NULL REFERENCES public.wallets(id) ON DELETE RESTRICT,
        transaction_id text NOT NULL,
        wallet_version bigint NOT NULL CHECK (wallet_version BETWEEN 1 AND 9007199254740991),
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount public.financial_amount NOT NULL CHECK (amount > 0),
        currency text NOT NULL,
        balance_before public.financial_amount NOT NULL,
        balance_after public.financial_amount NOT NULL,
        created_at timestamptz(3) NOT NULL CHECK (isfinite(created_at)),
        CONSTRAINT ledger_transaction_wallet_unique UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_wallet_version_unique UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_transaction_fk FOREIGN KEY (transaction_id, wallet_id, currency)
          REFERENCES public.wager_transactions(id, wallet_id, currency) ON DELETE RESTRICT,
        CONSTRAINT ledger_equation CHECK (
          (direction='DEBIT' AND balance_before - amount = balance_after) OR
          (direction='CREDIT' AND balance_before + amount = balance_after)
        )
      );

      CREATE FUNCTION public.reject_financial_mutation() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
      BEGIN
        RAISE EXCEPTION 'Forbidden % on financial table %', TG_OP, TG_TABLE_NAME USING ERRCODE='23514';
      END $function$;
      CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON public.wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION public.reject_financial_mutation();
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON public.wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_mutation();
      CREATE TRIGGER wallets_no_delete BEFORE DELETE ON public.wallets
        FOR EACH ROW EXECUTE FUNCTION public.reject_financial_mutation();
      CREATE TRIGGER wallets_no_truncate BEFORE TRUNCATE ON public.wallets
        FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_mutation();
      CREATE TRIGGER wagers_no_truncate BEFORE TRUNCATE ON public.wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION public.reject_financial_mutation();

      CREATE FUNCTION public.guard_wallet_state() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
      BEGIN
        IF TG_OP='INSERT' THEN
          IF NEW.version <> 1 THEN RAISE EXCEPTION 'Wallet starts at version one' USING ERRCODE='23514'; END IF;
        ELSE
          IF (NEW.id,NEW.player_id,NEW.currency,NEW.created_at) IS DISTINCT FROM
            (OLD.id,OLD.player_id,OLD.currency,OLD.created_at) THEN
            RAISE EXCEPTION 'Wallet identity is immutable' USING ERRCODE='23514';
          END IF;
          IF (NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1)
            OR (NEW.balance = OLD.balance AND (NEW.version <> OLD.version OR NEW.updated_at <> OLD.updated_at)) THEN
            RAISE EXCEPTION 'Each balance change increments version exactly once' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END $function$;
      CREATE TRIGGER guard_wallet_state BEFORE INSERT OR UPDATE ON public.wallets
        FOR EACH ROW EXECUTE FUNCTION public.guard_wallet_state();

      CREATE FUNCTION public.lock_ledger_wallet() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
      BEGIN
        PERFORM id FROM public.wallets WHERE id=NEW.wallet_id FOR NO KEY UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Ledger wallet does not exist' USING ERRCODE='23503'; END IF;
        RETURN NEW;
      END $function$;
      CREATE TRIGGER lock_ledger_wallet BEFORE INSERT ON public.wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION public.lock_ledger_wallet();

      CREATE FUNCTION public.check_wallet_movement() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
      DECLARE entry public.wallet_ledger_entries%ROWTYPE; before_amount numeric;
      BEGIN
        IF TG_OP='INSERT' THEN
          before_amount := 0;
          IF NEW.balance=0 THEN
            IF EXISTS (SELECT 1 FROM public.wallet_ledger_entries WHERE wallet_id=NEW.id AND wallet_version=1) THEN
              RAISE EXCEPTION 'Zero opening cannot have an opening ledger' USING ERRCODE='23514';
            END IF;
            RETURN NULL;
          END IF;
        ELSE
          IF NEW.balance=OLD.balance THEN RETURN NULL; END IF;
          before_amount := OLD.balance;
        END IF;
        SELECT * INTO entry FROM public.wallet_ledger_entries WHERE wallet_id=NEW.id AND wallet_version=NEW.version;
        IF NOT FOUND OR entry.balance_before <> before_amount OR entry.balance_after <> NEW.balance THEN
          RAISE EXCEPTION 'Wallet change requires its matching ledger entry' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END $function$;
      CREATE CONSTRAINT TRIGGER wallet_movement_consistency AFTER INSERT OR UPDATE ON public.wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_wallet_movement();

      CREATE FUNCTION public.check_ledger_entry() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
      DECLARE wallet public.wallets%ROWTYPE; operation public.wager_transactions%ROWTYPE;
        prior_amount numeric; reference_kind text; expected_direction text;
      BEGIN
        SELECT * INTO wallet FROM public.wallets WHERE id=NEW.wallet_id;
        SELECT * INTO operation FROM public.wager_transactions WHERE id=NEW.transaction_id;
        IF operation.status <> 'PROCESSED' OR operation.kind='LOSS' OR
          (operation.wallet_id,operation.currency,operation.amount) IS DISTINCT FROM
            (NEW.wallet_id,NEW.currency,NEW.amount) THEN
          RAISE EXCEPTION 'Ledger requires a matching processed financial transaction' USING ERRCODE='23514';
        END IF;
        expected_direction := CASE WHEN operation.kind='BET' THEN 'DEBIT' ELSE 'CREDIT' END;
        IF operation.kind='ROLLBACK' THEN
          SELECT kind INTO reference_kind FROM public.wager_transactions WHERE id=operation.reference_transaction_id;
          expected_direction := CASE WHEN reference_kind='BET' THEN 'CREDIT' ELSE 'DEBIT' END;
        END IF;
        IF NEW.direction <> expected_direction OR wallet.version < NEW.wallet_version
          OR (wallet.version=NEW.wallet_version AND wallet.balance <> NEW.balance_after) THEN
          RAISE EXCEPTION 'Ledger direction or final wallet state differs' USING ERRCODE='23514';
        END IF;
        IF NEW.wallet_version=1 THEN
          IF operation.kind <> 'OPENING' OR NEW.balance_before <> 0 THEN
            RAISE EXCEPTION 'Version one is reserved for positive opening' USING ERRCODE='23514';
          END IF;
        ELSE
          IF operation.kind='OPENING' THEN RAISE EXCEPTION 'Opening must be version one' USING ERRCODE='23514'; END IF;
          SELECT balance_after INTO prior_amount FROM public.wallet_ledger_entries
            WHERE wallet_id=NEW.wallet_id AND wallet_version=NEW.wallet_version-1;
          IF NOT FOUND THEN
            IF NEW.wallet_version=2 THEN prior_amount := 0;
            ELSE RAISE EXCEPTION 'Ledger version gap' USING ERRCODE='23514'; END IF;
          END IF;
          IF prior_amount <> NEW.balance_before THEN
            RAISE EXCEPTION 'Ledger balance chain is broken' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NULL;
      END $function$;
      CREATE CONSTRAINT TRIGGER ledger_entry_consistency AFTER INSERT ON public.wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_ledger_entry();

      CREATE FUNCTION public.check_transaction_ledger() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
      DECLARE operation public.wager_transactions%ROWTYPE; has_entry boolean;
      BEGIN
        -- Read final state, not an earlier PENDING snapshot queued in the same SQL transaction.
        SELECT * INTO operation FROM public.wager_transactions WHERE id=NEW.id;
        SELECT EXISTS (SELECT 1 FROM public.wallet_ledger_entries WHERE transaction_id=NEW.id)
          INTO has_entry;
        IF has_entry IS DISTINCT FROM (operation.status='PROCESSED' AND operation.kind <> 'LOSS') THEN
          RAISE EXCEPTION 'Transaction financial outcome and ledger disagree' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END $function$;
      CREATE CONSTRAINT TRIGGER transaction_ledger_consistency AFTER INSERT OR UPDATE ON public.wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_transaction_ledger();

      REVOKE ALL ON FUNCTION public.reject_financial_mutation(), public.guard_wallet_state(),
        public.lock_ledger_wallet(), public.check_wallet_movement(), public.check_ledger_entry(),
        public.check_transaction_ledger() FROM PUBLIC;
      GRANT SELECT, INSERT ON public.wallet_ledger_entries TO wager_app;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER transaction_ledger_consistency ON public.wager_transactions;
      DROP TRIGGER wagers_no_truncate ON public.wager_transactions;
      DROP TRIGGER wallet_movement_consistency ON public.wallets;
      DROP TRIGGER guard_wallet_state ON public.wallets;
      DROP TRIGGER wallets_no_delete ON public.wallets;
      DROP TRIGGER wallets_no_truncate ON public.wallets;
      DROP TABLE public.wallet_ledger_entries;
      DROP FUNCTION public.check_transaction_ledger(), public.check_ledger_entry(), public.check_wallet_movement(),
        public.lock_ledger_wallet(), public.guard_wallet_state(), public.reject_financial_mutation();
    `);
  }
}
