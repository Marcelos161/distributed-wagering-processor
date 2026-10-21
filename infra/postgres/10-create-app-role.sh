#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$POSTGRES_APP_PASSWORD" --set=db_name="$POSTGRES_DB" <<'SQL'
CREATE ROLE wager_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE :"db_name" TO wager_app;
GRANT USAGE ON SCHEMA public TO wager_app;
SQL
