import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000009 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE public.pending_reference_jobs (
        transaction_id text PRIMARY KEY REFERENCES public.wager_transactions(id),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
        next_attempt_at timestamptz(3) NOT NULL,
        completed_at timestamptz(3)
      );
      CREATE INDEX pending_reference_due_idx ON public.pending_reference_jobs(next_attempt_at,transaction_id) WHERE completed_at IS NULL;
      CREATE FUNCTION public.schedule_pending_reference() RETURNS trigger LANGUAGE plpgsql
        SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
      BEGIN
        IF NEW.status='PENDING_REFERENCE' THEN
          INSERT INTO public.pending_reference_jobs(transaction_id,next_attempt_at) VALUES(NEW.id,NEW.created_at) ON CONFLICT DO NOTHING;
        END IF;
        RETURN NEW;
      END $fn$;
      REVOKE ALL ON FUNCTION public.schedule_pending_reference() FROM PUBLIC;
      CREATE TRIGGER schedule_pending_reference AFTER INSERT OR UPDATE OF status ON public.wager_transactions
        FOR EACH ROW EXECUTE FUNCTION public.schedule_pending_reference();
      INSERT INTO public.pending_reference_jobs(transaction_id,next_attempt_at)
        SELECT id,created_at FROM public.wager_transactions WHERE status='PENDING_REFERENCE';
      GRANT SELECT ON public.pending_reference_jobs TO wager_app;
      GRANT UPDATE(attempts,next_attempt_at,completed_at) ON public.pending_reference_jobs TO wager_app;
    `);
  }
  override async down(): Promise<void> {
    this.addSql(`
      DO $guard$ BEGIN
        IF EXISTS(SELECT 1 FROM public.pending_reference_jobs WHERE attempts>0 OR completed_at IS NOT NULL) THEN
          RAISE EXCEPTION 'Cannot discard durable reference scheduling history' USING ERRCODE='55000';
        END IF;
      END $guard$;
      DROP TRIGGER schedule_pending_reference ON public.wager_transactions;
      DROP FUNCTION public.schedule_pending_reference();
      DROP TABLE public.pending_reference_jobs;
    `);
  }
}
