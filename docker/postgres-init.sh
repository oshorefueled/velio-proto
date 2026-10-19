#!/usr/bin/env bash
# First-boot database initialization. The postgres image runs scripts in
# /docker-entrypoint-initdb.d only when the data volume is empty, so this
# script may assume a fresh cluster; a partially failed init aborts startup
# and `docker compose down -v` resets to a clean first boot.
set -euo pipefail

psql --set ON_ERROR_STOP=1 \
  --set app_pw="${VELIO_APP_PASSWORD:-velio_app_dev}" \
  --set migrator_pw="${VELIO_MIGRATOR_PASSWORD:-velio_migrator_dev}" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE velio_app LOGIN PASSWORD :'app_pw';
CREATE ROLE velio_migrator LOGIN PASSWORD :'migrator_pw';
CREATE DATABASE velio_test OWNER velio_migrator;
EOSQL

# Default privileges are per-database: grant them wherever the migrator will
# create schema, so the application role gets DML (never DDL) on future tables.
for db in velio velio_test; do
  psql --set ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" --dbname "$db" <<'EOSQL'
GRANT USAGE, CREATE ON SCHEMA public TO velio_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE velio_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO velio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE velio_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO velio_app;
EOSQL
done
