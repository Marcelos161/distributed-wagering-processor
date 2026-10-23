import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000004 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION public.message_json_id(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE
        SET search_path=pg_catalog,public AS $fn$
        SELECT COALESCE(jsonb_typeof(v)='string' AND v #>> '{}' <> '' AND v #>> '{}' !~ '[[:space:][:cntrl:]]',false)
      $fn$;
      CREATE FUNCTION public.message_json_money(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE
        SET search_path=pg_catalog,public AS $fn$
      BEGIN
        IF NOT COALESCE(jsonb_typeof(v)='object' AND jsonb_typeof(v->'amount')='string'
          AND v->>'amount' ~ '^[0-9]+[.][0-9]{2}$' AND v->>'currency' IN ('BRL','USD','EUR'),false) THEN RETURN false; END IF;
        PERFORM (v->>'amount')::public.financial_amount;
        RETURN true;
      EXCEPTION WHEN OTHERS THEN RETURN false;
      END $fn$;
      CREATE FUNCTION public.valid_integration_payload(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE
        SET search_path=pg_catalog,public AS $fn$
      DECLARE d jsonb := p->'data'; k text; amount numeric; before_amount numeric; after_amount numeric;
      BEGIN
        IF NOT COALESCE(jsonb_typeof(p)='object' AND p->'version'='1'::jsonb
          AND jsonb_typeof(p->'occurredAt')='string'
          AND p->>'occurredAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          AND jsonb_typeof(d)='object',false) THEN RETURN false; END IF;
        FOREACH k IN ARRAY ARRAY['eventId','aggregateId','correlationId'] LOOP
          IF NOT public.message_json_id(p->k) THEN RETURN false; END IF;
        END LOOP;
        IF p ? 'causationId' AND NOT public.message_json_id(p->'causationId') THEN RETURN false; END IF;
        FOREACH k IN ARRAY ARRAY['walletId','transactionId'] LOOP
          IF NOT public.message_json_id(d->k) THEN RETURN false; END IF;
        END LOOP;
        IF NOT public.message_json_money(d->'money') THEN RETURN false; END IF;
        amount := (d->'money'->>'amount')::numeric;
        IF p->>'eventType'='WalletBalanceChanged' THEN
          IF NOT public.message_json_money(d->'balanceBefore') OR NOT public.message_json_money(d->'balanceAfter') THEN RETURN false; END IF;
          before_amount := (d->'balanceBefore'->>'amount')::numeric;
          after_amount := (d->'balanceAfter'->>'amount')::numeric;
          RETURN COALESCE(p->>'aggregateId'=d->>'walletId' AND amount>0
            AND jsonb_typeof(d->'walletVersion')='number' AND d->>'walletVersion' ~ '^[1-9][0-9]*$'
            AND (d->>'walletVersion')::numeric <= 9007199254740991
            AND d->'money'->>'currency'=d->'balanceBefore'->>'currency'
            AND d->'money'->>'currency'=d->'balanceAfter'->>'currency'
            AND ((d->>'direction'='DEBIT' AND before_amount-amount=after_amount)
              OR (d->>'direction'='CREDIT' AND before_amount+amount=after_amount)),false);
        END IF;
        FOREACH k IN ARRAY ARRAY['providerId','externalTransactionId','playerId','roundId','gameId'] LOOP
          IF NOT public.message_json_id(d->k) THEN RETURN false; END IF;
        END LOOP;
        FOREACH k IN ARRAY ARRAY['referenceExternalTransactionId','referenceTransactionId'] LOOP
          IF d ? k AND NOT public.message_json_id(d->k) THEN RETURN false; END IF;
        END LOOP;
        RETURN COALESCE(p->>'aggregateId'=d->>'transactionId'
          AND d->>'kind' IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')
          AND ((d->>'kind'='LOSS' AND amount=0) OR (d->>'kind'<>'LOSS' AND amount>0))
          AND ((p->>'eventType'='WagerTransactionProcessed' AND d->>'status'='PROCESSED')
            OR (p->>'eventType'='WagerTransactionRejected' AND d->>'status'='REJECTED'
              AND d->>'failureCode' IN ('INSUFFICIENT_FUNDS','REVERSAL_INSUFFICIENT_FUNDS','REFERENCE_NOT_FOUND','INVALID_REFERENCE','DUPLICATE_REVERSAL','DOMAIN_RULE_VIOLATION'))
            OR (p->>'eventType'='WagerTransactionPendingReference' AND d->>'status'='PENDING_REFERENCE'
              AND public.message_json_id(d->'referenceExternalTransactionId'))),false);
      END $fn$;

      CREATE TABLE public.inbox_messages (
        consumer_name text NOT NULL CHECK (consumer_name<>'' AND consumer_name !~ '[[:space:][:cntrl:]]'),
        message_id text NOT NULL CHECK (message_id<>'' AND message_id !~ '[[:space:][:cntrl:]]'),
        payload_hash text NOT NULL CHECK (payload_hash<>'' AND payload_hash !~ '[[:space:][:cntrl:]]'),
        received_at timestamptz(3) NOT NULL CHECK (isfinite(received_at)),
        processed_at timestamptz(3) CHECK (isfinite(processed_at) AND processed_at>=received_at),
        PRIMARY KEY (consumer_name,message_id)
      );
      CREATE TABLE public.outbox_messages (
        id text PRIMARY KEY, aggregate_id text NOT NULL, event_type text NOT NULL,
        payload jsonb NOT NULL CHECK (public.valid_integration_payload(payload)),
        occurred_at timestamptz(3) NOT NULL CHECK (isfinite(occurred_at)),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
        next_attempt_at timestamptz(3) CHECK (isfinite(next_attempt_at) AND next_attempt_at>=occurred_at),
        published_at timestamptz(3) CHECK (isfinite(published_at) AND published_at>=occurred_at),
        CHECK (payload->>'eventId'=id AND payload->>'aggregateId'=aggregate_id AND payload->>'eventType'=event_type
          AND (payload->>'occurredAt')::timestamptz=occurred_at),
        CHECK ((published_at IS NOT NULL AND next_attempt_at IS NULL) OR
          (published_at IS NULL AND (attempts>0)=(next_attempt_at IS NOT NULL)))
      );
      CREATE INDEX outbox_due_idx ON public.outbox_messages ((COALESCE(next_attempt_at,occurred_at)),occurred_at,id)
        WHERE published_at IS NULL;
      CREATE FUNCTION public.guard_message_state() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
      BEGIN
        IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Messages cannot be removed' USING ERRCODE='23514'; END IF;
        IF TG_TABLE_NAME='inbox_messages' THEN
          IF OLD.processed_at IS NOT NULL OR NEW.processed_at IS NULL OR
            (to_jsonb(NEW)-'processed_at') IS DISTINCT FROM (to_jsonb(OLD)-'processed_at') THEN
            RAISE EXCEPTION 'Invalid inbox transition' USING ERRCODE='23514';
          END IF;
        ELSE
          IF OLD.published_at IS NOT NULL OR
            (to_jsonb(NEW)-ARRAY['attempts','next_attempt_at','published_at']) IS DISTINCT FROM
            (to_jsonb(OLD)-ARRAY['attempts','next_attempt_at','published_at']) OR NOT (
              (NEW.published_at IS NOT NULL AND NEW.attempts=OLD.attempts AND NEW.next_attempt_at IS NULL
                AND NEW.published_at>=COALESCE(OLD.next_attempt_at,OLD.occurred_at)) OR
              (NEW.published_at IS NULL AND NEW.attempts::bigint=OLD.attempts::bigint+1
                AND NEW.next_attempt_at>COALESCE(OLD.next_attempt_at,OLD.occurred_at))) THEN
            RAISE EXCEPTION 'Invalid outbox transition' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER inbox_guard BEFORE UPDATE OR DELETE ON public.inbox_messages FOR EACH ROW EXECUTE FUNCTION public.guard_message_state();
      CREATE TRIGGER inbox_no_truncate BEFORE TRUNCATE ON public.inbox_messages FOR EACH STATEMENT EXECUTE FUNCTION public.guard_message_state();
      CREATE TRIGGER outbox_guard BEFORE UPDATE OR DELETE ON public.outbox_messages FOR EACH ROW EXECUTE FUNCTION public.guard_message_state();
      CREATE TRIGGER outbox_no_truncate BEFORE TRUNCATE ON public.outbox_messages FOR EACH STATEMENT EXECUTE FUNCTION public.guard_message_state();
      REVOKE ALL ON FUNCTION public.message_json_id(jsonb), public.message_json_money(jsonb), public.valid_integration_payload(jsonb), public.guard_message_state() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.message_json_id(jsonb), public.message_json_money(jsonb), public.valid_integration_payload(jsonb) TO wager_app;
      GRANT SELECT, INSERT ON public.inbox_messages, public.outbox_messages TO wager_app;
      GRANT UPDATE(processed_at) ON public.inbox_messages TO wager_app;
      GRANT UPDATE(attempts,next_attempt_at,published_at) ON public.outbox_messages TO wager_app;
    `);
  }
  override async down(): Promise<void> {
    this.addSql(`DROP TABLE public.outbox_messages; DROP TABLE public.inbox_messages;
      DROP FUNCTION public.guard_message_state(), public.valid_integration_payload(jsonb), public.message_json_money(jsonb), public.message_json_id(jsonb);`);
  }
}
