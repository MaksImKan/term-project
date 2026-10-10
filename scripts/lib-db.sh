#!/usr/bin/env bash
# shellcheck shell=bash
#
# Спільна частина для scripts/backup.sh і scripts/restore-drill.sh:
# розбір рядка підключення і запуск клієнтських утиліт Postgres.
#
# Рядок підключення приходить ЛИШЕ з оточення — його наповнює обгортка сховища
# scripts/with-secrets.sh (ДЗ-11). Жодного власного env-файла тут не читається.
#
#   bash scripts/with-secrets.sh dev bash scripts/backup.sh     # зі сховища
#   SKIP_VAULT=1 DATABASE_URL=… bash scripts/backup.sh          # CI / грейдер

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "✖ $*" >&2; exit 1; }
log() { echo "  $*"; }

# ── Рядок підключення ────────────────────────────────────────────────────────
DB_URL_RAW="${DATABASE_URL:-${DB_URL:-}}"
[ -n "$DB_URL_RAW" ] || die "Не задано DATABASE_URL (або DB_URL).
Основний шлях — зі сховища:
    bash scripts/with-secrets.sh dev bash scripts/$(basename "${0:-backup.sh}")
Без сховища (CI, грейдер):
    export DATABASE_URL=postgres://marketplace:dev_password_0@127.0.0.1:6432/marketplace
    export SKIP_VAULT=1"

if [[ "$DB_URL_RAW" =~ ^postgres(ql)?://([^:/?#@]+)(:([^@/?#]*))?@([^:/?#]+)(:([0-9]+))?/([^?#]+) ]]; then
  DB_USER="${BASH_REMATCH[2]}"
  DB_PASSWORD="${BASH_REMATCH[4]:-}"
  DB_HOST="${BASH_REMATCH[5]}"
  DB_PORT="${BASH_REMATCH[7]:-5432}"
  DB_NAME="${BASH_REMATCH[8]}"
else
  die "Не вдалося розібрати DATABASE_URL. Очікую postgres://user[:pass]@host[:port]/dbname"
fi

# Пароль у DSN може бути відсутній — за конвенцією ДЗ-11 він живе окремо, у
# файлі-секреті, який ротується без рестарту застосунку.
if [ -z "$DB_PASSWORD" ]; then
  if [ -n "${PGPASSWORD:-}" ]; then
    DB_PASSWORD="$PGPASSWORD"
  elif [ -f "${DB_PASSWORD_FILE:-$REPO_ROOT/secrets/db_password}" ]; then
    DB_PASSWORD="$(tr -d '\n' < "${DB_PASSWORD_FILE:-$REPO_ROOT/secrets/db_password}")"
  else
    die "У DSN немає пароля, і файл-секрет не знайдено.
Створи його (npm run secrets:init) або вкажи пароль у DATABASE_URL."
  fi
fi

# ── Прямий порт Postgres, в обхід пулера ─────────────────────────────────────
#
# DATABASE_URL вказує на PgBouncer (6432) — туди ходить застосунок. Але
# pg_dump і pg_restore через pool_mode = transaction працювати НЕ можуть:
# pg_dump відкриває транзакцію, виставляє їй snapshot і паралельні зʼєднання
# чіпляє до того самого snapshot, а транзакційний пулер роздає ці зʼєднання
# різним серверним бекендам. Тому дамп завжди йде напряму в Postgres.
DIRECT_PORT="${DIRECT_DB_PORT:-5432}"
if [ "$DB_PORT" = "$DIRECT_PORT" ]; then
  POOLED_NOTE="(DATABASE_URL уже вказує напряму в Postgres)"
else
  POOLED_NOTE="(DATABASE_URL вказує на пулер :$DB_PORT, дамп іде напряму в :$DIRECT_PORT)"
fi

# ── Запуск клієнтських утиліт ────────────────────────────────────────────────
#
# Спершу пробуємо утиліту на хості. Якщо її немає (типова ситуація на машині,
# де стоїть лише Node), ідемо в контейнер db — там psql і pg_dump рівно тієї
# версії, що й сервер, і це взагалі найнадійніший варіант.
COMPOSE_DB_SERVICE="${COMPOSE_DB_SERVICE:-db}"

compose_db_available() {
  command -v docker >/dev/null 2>&1 || return 1
  ( cd "$REPO_ROOT" && docker compose ps -q "$COMPOSE_DB_SERVICE" 2>/dev/null | grep -q . )
}

# pg_tool <утиліта> <аргументи…> — підключення додається автоматично.
# stdout утиліти лишається stdout, тож `pg_tool pg_dump -Fc > file` працює.
pg_tool() {
  local tool="$1"; shift
  if command -v "$tool" >/dev/null 2>&1; then
    PGPASSWORD="$DB_PASSWORD" "$tool" -h "$DB_HOST" -p "$DIRECT_PORT" -U "$DB_USER" "$@"
  elif compose_db_available; then
    ( cd "$REPO_ROOT" && docker compose exec -T -e PGPASSWORD="$DB_PASSWORD" \
        "$COMPOSE_DB_SERVICE" "$tool" -h 127.0.0.1 -p 5432 -U "$DB_USER" "$@" )
  else
    die "Немає ані $tool на хості, ані піднятого сервісу '$COMPOSE_DB_SERVICE'.
Підніми стенд: docker compose up -d --wait"
  fi
}

# Контрольне значення для порівняння «до / після» — одним рядком, як на лекції.
CHECKSUM_TABLE="${CHECKSUM_TABLE:-orders}"
CHECKSUM_SQL="SELECT count(*) || '|' || coalesce(sum(total_cents), 0) FROM ${CHECKSUM_TABLE}"

checksum_of_live_db() {
  pg_tool psql -d "$DB_NAME" -Atc "$CHECKSUM_SQL"
}

# Тека для дампів. Поза контейнером — звичайна тека репозиторію, у .gitignore.
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
