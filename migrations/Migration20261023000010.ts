import { Migration } from '@mikro-orm/migrations';
export class Migration20261023000010 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE public.outbox_claims (
      event_id text PRIMARY KEY REFERENCES public.outbox_messages(id),
      token text NOT NULL,
      lease_until timestamptz(3) NOT NULL CHECK(isfinite(lease_until))
    );
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.outbox_claims TO wager_app;`);
  }
  override async down(): Promise<void> {
    this.addSql(`DO $guard$ BEGIN
      IF EXISTS(SELECT 1 FROM public.outbox_claims) THEN RAISE EXCEPTION 'Cannot remove active publisher claims' USING ERRCODE='55000'; END IF;
    END $guard$; DROP TABLE public.outbox_claims;`);
  }
}
