#!/usr/bin/env bash
#
# Ротація пароля Postgres БЕЗ рестарту застосунку.
#
# Механіка: застосунок передає у pg.Pool не рядок-пароль, а функцію, яку pg
# викликає на КОЖНЕ нове зʼєднання. Тож достатньо змінити пароль у БД,
# оновити файл-секрет і закрити старі зʼєднання — пул переконнектиться сам.
#
# Порядок кроків важливий:
#   1) ALTER ROLE            — новий пароль стає дійсним у БД;
#   2) запис файла-секрета   — застосунок дізнається про нього;
#   3) pg_terminate_backend  — старі зʼєднання закриваються.
# Між (1) і (2) є вікно в кілька мілісекунд, коли нове зʼєднання спробувало б
# старий пароль і отримало б password authentication failed. Промислове
# рішення цієї гонки — alternating users: дві ролі, які ротуються по черзі
# (див. AWS Secrets Manager rotation strategies). Для ДЗ вікно приймаємо.
#
# Використання:
#   bash rotate.sh              # згенерувати випадковий пароль
#   bash rotate.sh 'myNewPass'  # задати конкретний
#
# Змінні: DB_SERVICE, DB_USER, DB_NAME, DB_HOST, DB_PORT, DB_PASSWORD_FILE,
#         PSQL_MODE=compose|local (типово визначається автоматично).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SECRET_FILE="${DB_PASSWORD_FILE:-$ROOT/secrets/db_password}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_USER="${DB_USER:-marketplace}"
DB_NAME="${DB_NAME:-marketplace}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
APP_URL="${APP_URL:-http://localhost:3000}"

# Пароль — лише латиниця й цифри: не треба екранувати ані в SQL, ані в DSN.
# Свідомо без `tr ... | head -c`: head закриває канал, tr отримує SIGPIPE, і при
# `set -o pipefail` скрипт мовчки падає з кодом 141 ще до першого кроку.
gen_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    dd if=/dev/urandom bs=1024 count=1 2>/dev/null | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-32
  fi
}
NEW_PASSWORD="${1:-$(gen_password)}"

if [ ! -f "$SECRET_FILE" ]; then
  echo "✖ Немає файла-секрета: $SECRET_FILE (створи: npm run secrets:init)" >&2
  exit 1
fi

# Типовий шлях — Postgres із docker-compose.yml цього репо. Якщо сервіс не
# піднято (Postgres стоїть локально), ходимо звичайним psql по TCP.
detect_mode() {
  if [ -n "${PSQL_MODE:-}" ]; then echo "$PSQL_MODE"; return; fi
  if command -v docker >/dev/null 2>&1 && [ -n "$(docker compose ps -q "$DB_SERVICE" 2>/dev/null)" ]; then
    echo compose
  else
    echo local
  fi
}
MODE="$(detect_mode)"

# У compose-режимі psql ходить через unix-сокет усередині контейнера (trust),
# у локальному — по TCP з поточним паролем із файла-секрета.
psql_exec() {
  case "$MODE" in
    compose)
      (cd "$ROOT" && docker compose exec -T -e PGPASSWORD="$(cat "$SECRET_FILE")" "$DB_SERVICE" \
        psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -tAc "$1")
      ;;
    *)
      PGPASSWORD="$(cat "$SECRET_FILE")" psql -v ON_ERROR_STOP=1 \
        -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "$1"
      ;;
  esac
}

echo "▸ режим: $MODE (сервіс '$DB_SERVICE', роль '$DB_USER', БД '$DB_NAME')"

echo "▸ 1/3  ALTER ROLE $DB_USER — новий пароль у БД"
psql_exec "ALTER ROLE \"$DB_USER\" WITH PASSWORD '$NEW_PASSWORD';" >/dev/null

echo "▸ 2/3  оновлюю файл-секрет $SECRET_FILE (атомарно через mv)"
umask 077
printf '%s' "$NEW_PASSWORD" > "$SECRET_FILE.tmp"
mv -f "$SECRET_FILE.tmp" "$SECRET_FILE"

echo "▸ 3/3  закриваю старі зʼєднання (pg_terminate_backend)"
KILLED="$(psql_exec "SELECT count(*) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND usename = '$DB_USER' AND pid <> pg_backend_pid();")"
psql_exec "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND usename = '$DB_USER' AND pid <> pg_backend_pid();" >/dev/null

echo "  закрито зʼєднань: ${KILLED:-0}"
echo
echo "✔ Пароль ротовано. Застосунок НЕ перезапускався:"
echo "    curl -s $APP_URL/health      # uptime_seconds має зрости"
echo "    curl -s $APP_URL/products    # запит у БД має віддати 200"
