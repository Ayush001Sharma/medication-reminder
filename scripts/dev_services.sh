#!/usr/bin/env bash
# Start local PostgreSQL and Redis for development (Linux cloud environment, no Docker).
# Idempotent: safe to re-run in a new session. Installs via apt if missing.
#
# LOCAL DEVELOPMENT ONLY. This creates a database role "medreminder" with the well-known password
# "medreminder" and no more rights than the tests need (LOGIN + CREATEDB, not a superuser). Never
# reuse that role or password anywhere reachable from a network. It is a convenience for this
# container: the project itself does not need this script (see the README for Windows, macOS, Linux).
set -euo pipefail

DB_NAME="${DB_NAME:-medreminder}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
# Run a command as the postgres OS user.
as_pg() { if [ "$(id -u)" -eq 0 ]; then runuser -u postgres -- "$@"; else sudo -u postgres "$@"; fi; }

if ! command -v pg_ctlcluster >/dev/null || ! command -v redis-server >/dev/null; then
  echo "Installing PostgreSQL and Redis via apt..."
  $SUDO apt-get update -qq
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql redis-server
fi

# --- PostgreSQL ---
PG_VER="$(ls /usr/lib/postgresql | sort -V | tail -1)"
if ! pg_lsclusters | grep -q online; then
  $SUDO pg_ctlcluster "$PG_VER" main start
fi
for _ in $(seq 1 20); do as_pg pg_isready -q && break || sleep 1; done
# Local dev role + database (password is a dev-only placeholder, not a secret).
as_pg psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname='medreminder'" | grep -q 1 \
  || as_pg psql -qc "CREATE ROLE medreminder LOGIN CREATEDB PASSWORD 'medreminder'"
# Roles made by older versions of this script were superusers: take that right away.
as_pg psql -qc "ALTER ROLE medreminder NOSUPERUSER CREATEDB"
as_pg psql -qtAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || as_pg createdb -O medreminder "${DB_NAME}"

# --- Redis ---
if ! redis-cli ping >/dev/null 2>&1; then
  redis-server --daemonize yes --port 6379 --save "" >/dev/null
fi
for _ in $(seq 1 10); do redis-cli ping >/dev/null 2>&1 && break || sleep 1; done

echo "PostgreSQL: $(pg_isready)"
echo "Redis: $(redis-cli ping)"
