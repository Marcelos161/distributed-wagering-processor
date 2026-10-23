import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE public.wager_transactions (
        id text PRIMARY KEY CHECK (id <> '' AND id !~ '[[:space:][:cntrl:]]'),
        provider_id text NOT NULL CHECK (provider_id <> '' AND provider_id !~ '[[:space:][:cntrl:]]'),
        external_transaction_id text NOT NULL CHECK (external_transaction_id <> '' AND external_transaction_id !~ '[[:space:][:cntrl:]]'),
        idempotency_key text NOT NULL CHECK (idempotency_key <> '' AND idempotency_key !~ '[[:space:][:cntrl:]]'),
        payload_hash text NOT NULL CHECK (payload_hash <> '' AND payload_hash !~ '[[:space:][:cntrl:]]'),
        wallet_id text NOT NULL,
        player_id text NOT NULL,
        round_id text NOT NULL CHECK (round_id <> '' AND round_id !~ '[[:space:][:cntrl:]]'),
        game_id text NOT NULL CHECK (game_id <> '' AND game_id !~ '[[:space:][:cntrl:]]'),
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount public.financial_amount NOT NULL,
        currency text NOT NULL,
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        reference_external_transaction_id text,
        reference_transaction_id text REFERENCES public.wager_transactions(id) ON DELETE RESTRICT,
        failure_code text,
        created_at timestamptz(3) NOT NULL CHECK (isfinite(created_at)),
        processed_at timestamptz(3) CHECK (isfinite(processed_at)),
        CONSTRAINT wager_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_idempotency_unique UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_identity_wallet_currency_unique UNIQUE (id, wallet_id, currency),
        CONSTRAINT wager_wallet_fk FOREIGN KEY (wallet_id, player_id, currency)
          REFERENCES public.wallets(id, player_id, currency) ON DELETE RESTRICT,
        CONSTRAINT wager_amount_by_kind CHECK ((kind = 'LOSS' AND amount = 0) OR (kind <> 'LOSS' AND amount > 0)),
        CONSTRAINT wager_reference_shape CHECK (
          (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)
          AND (kind NOT IN ('OPENING','BET','LOSS') OR reference_external_transaction_id IS NULL)
          AND (reference_external_transaction_id IS NULL OR
            (reference_external_transaction_id <> '' AND reference_external_transaction_id !~ '[[:space:][:cntrl:]]'
              AND reference_external_transaction_id <> external_transaction_id))
          AND (reference_transaction_id IS NULL OR reference_transaction_id <> id)
        ),
        CONSTRAINT wager_lifecycle_shape CHECK (
          (status = 'PROCESSED') = (processed_at IS NOT NULL)
          AND (reference_transaction_id IS NOT NULL) = (status = 'PROCESSED' AND reference_external_transaction_id IS NOT NULL)
          AND (status <> 'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL)
          AND (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT wager_failure_code CHECK (
          failure_code IS NULL OR
          (status = 'FAILED' AND failure_code = 'PERMANENT_INFRASTRUCTURE_FAILURE') OR
          (status = 'REJECTED' AND (
            failure_code = 'DOMAIN_RULE_VIOLATION'
            OR (failure_code = 'INSUFFICIENT_FUNDS' AND kind = 'BET')
            OR (failure_code = 'REVERSAL_INSUFFICIENT_FUNDS' AND kind = 'ROLLBACK')
            OR (failure_code = 'DUPLICATE_REVERSAL' AND kind IN ('REFUND','ROLLBACK'))
            OR (failure_code IN ('REFERENCE_NOT_FOUND','INVALID_REFERENCE') AND reference_external_transaction_id IS NOT NULL)
          ))
        )
      );
      CREATE UNIQUE INDEX wager_successful_reversal_unique
        ON public.wager_transactions(reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE UNIQUE INDEX wager_opening_wallet_unique ON public.wager_transactions(wallet_id)
        WHERE kind = 'OPENING' AND status = 'PROCESSED';
      CREATE INDEX wager_pending_reference_idx ON public.wager_transactions(created_at, id)
        WHERE status = 'PENDING_REFERENCE';
      CREATE INDEX wager_pending_idx ON public.wager_transactions(created_at, id) WHERE status = 'PENDING';
      CREATE INDEX wager_wallet_idx ON public.wager_transactions(wallet_id, created_at, id);
      CREATE INDEX wager_reference_idx ON public.wager_transactions(reference_transaction_id)
        WHERE reference_transaction_id IS NOT NULL;

      CREATE FUNCTION public.guard_wager_transaction() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
      DECLARE referenced public.wager_transactions%ROWTYPE;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Financial transactions cannot be deleted' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
            RAISE EXCEPTION 'Terminal transaction is immutable' USING ERRCODE = '23514';
          END IF;
          IF (to_jsonb(NEW) - ARRAY['status','reference_transaction_id','failure_code','processed_at'])
            IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','reference_transaction_id','failure_code','processed_at']) THEN
            RAISE EXCEPTION 'Transaction identity and input are immutable' USING ERRCODE = '23514';
          END IF;
          IF NOT (NEW.status IN ('PROCESSED','REJECTED','FAILED') OR
            (OLD.status = 'PENDING' AND NEW.status = 'PENDING_REFERENCE')) THEN
            RAISE EXCEPTION 'Invalid transaction transition' USING ERRCODE = '23514';
          END IF;
        END IF;
        IF NEW.status = 'PROCESSED' AND NEW.reference_transaction_id IS NOT NULL THEN
          SELECT * INTO referenced FROM public.wager_transactions WHERE id = NEW.reference_transaction_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Reference does not exist' USING ERRCODE = '23503';
          END IF;
          IF referenced.id = NEW.id OR referenced.status <> 'PROCESSED'
            OR (referenced.provider_id, referenced.player_id, referenced.wallet_id, referenced.currency,
                referenced.round_id, referenced.external_transaction_id)
              IS DISTINCT FROM (NEW.provider_id, NEW.player_id, NEW.wallet_id, NEW.currency,
                NEW.round_id, NEW.reference_external_transaction_id)
            OR NOT (referenced.kind = 'BET' OR (NEW.kind = 'ROLLBACK' AND referenced.kind IN ('WIN','REFUND')))
            OR (NEW.kind IN ('REFUND','ROLLBACK') AND NEW.amount <> referenced.amount) THEN
            RAISE EXCEPTION 'Invalid processed reference' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $function$;
      CREATE TRIGGER guard_wager_transaction BEFORE INSERT OR UPDATE OR DELETE ON public.wager_transactions
        FOR EACH ROW EXECUTE FUNCTION public.guard_wager_transaction();
      REVOKE ALL ON FUNCTION public.guard_wager_transaction() FROM PUBLIC;
      GRANT SELECT, INSERT ON public.wager_transactions TO wager_app;
      GRANT UPDATE (status, reference_transaction_id, failure_code, processed_at) ON public.wager_transactions TO wager_app;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE public.wager_transactions; DROP FUNCTION public.guard_wager_transaction();');
  }
}
