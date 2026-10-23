import { Migration } from '@mikro-orm/migrations';

export class Migration20261023000001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE DOMAIN public.financial_amount AS numeric
        CONSTRAINT financial_amount_range CHECK (VALUE >= 0 AND VALUE <= 999999999999999999.99)
        CONSTRAINT financial_amount_scale CHECK (scale(VALUE) <= 2);
      CREATE TABLE public.wallets (
        id text PRIMARY KEY CHECK (id <> '' AND id !~ '[[:space:][:cntrl:]]'),
        player_id text NOT NULL CHECK (player_id <> '' AND player_id !~ '[[:space:][:cntrl:]]'),
        currency text NOT NULL CHECK (currency IN ('BRL', 'USD', 'EUR')),
        balance public.financial_amount NOT NULL,
        version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
        created_at timestamptz(3) NOT NULL CHECK (isfinite(created_at)),
        updated_at timestamptz(3) NOT NULL CHECK (isfinite(updated_at)),
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_identity_currency_unique UNIQUE (id, player_id, currency)
      );
      GRANT SELECT, INSERT ON public.wallets TO wager_app;
      GRANT UPDATE (balance, version, updated_at) ON public.wallets TO wager_app;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE public.wallets; DROP DOMAIN public.financial_amount;');
  }
}
