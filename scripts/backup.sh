#!/usr/bin/env bash
#
# Бекап бази курсового проєкту: pg_dump -Fc у файл із датою в імені.
#
#   bash scripts/with-secrets.sh dev bash scripts/backup.sh     # основний шлях
#   SKIP_VAULT=1 DATABASE_URL=… bash scripts/backup.sh          # CI / грейдер
#
# Куди складає: локальна тека backups/ поза контейнером (BACKUP_DIR перевизначає).
# S3 буде у ДЗ-26; тоді ключі ляжуть у те саме сховище, а не в новий env-файл.
#
# Поруч із дампом пишуться два службові файли:
#   *.checksum — контрольне значення бази НА МОМЕНТ ДАМПУ (count|sum по orders).
#                Саме з ним порівнюється відновлена база у restore-drill.sh:
#                порівнювати з живою базою нечесно, вона вже змінилась.
#   *.sha256   — цілісність самого архіву.
set -euo pipefail

# shellcheck source=scripts/lib-db.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-db.sh"

STARTED_AT=$(date +%s)
STAMP="$(date +%Y-%m-%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
DUMP_FILE="$BACKUP_DIR/${DB_NAME}_${STAMP}.dump"

echo "── backup ──"
log "база:        $DB_NAME на $DB_HOST:$DIRECT_PORT $POOLED_NOTE"
log "призначення: $BACKUP_DIR"

# Контрольне значення знімаємо ДО дампу й у тій самій хвилині: дамп -Fc бере
# узгоджений snapshot, тож розбіжність можлива лише під активним записом —
# для цього й існує restore-drill, який порівнює з цим числом.
CHECKSUM="$(checksum_of_live_db | tr -d '[:space:]')"
log "контрольне значення (count|sum по $CHECKSUM_TABLE): $CHECKSUM"

# -Fc — custom format: стискає, дозволяє pg_restore --list і вибіркове
# відновлення. --no-owner/--no-acl, щоб дамп ліг у чисту базу з іншим власником
# (саме так його відновлює drill).
pg_tool pg_dump -d "$DB_NAME" -Fc --no-owner --no-acl > "$DUMP_FILE"

printf '%s\n' "$CHECKSUM" > "$DUMP_FILE.checksum"
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$BACKUP_DIR" && sha256sum "$(basename "$DUMP_FILE")" > "$DUMP_FILE.sha256" )
elif command -v shasum >/dev/null 2>&1; then
  ( cd "$BACKUP_DIR" && shasum -a 256 "$(basename "$DUMP_FILE")" > "$DUMP_FILE.sha256" )
fi

SIZE_BYTES=$(wc -c < "$DUMP_FILE" | tr -d ' ')
SIZE_HUMAN=$(du -h "$DUMP_FILE" | cut -f1)
ELAPSED=$(( $(date +%s) - STARTED_AT ))

# Доказ валідного -Fc архіву: TOC читається. pg_restore на хості є не завжди —
# тоді рядок просто не друкуємо, придатність архіву все одно доводить drill.
if command -v pg_restore >/dev/null 2>&1; then
  TOC_LINES=$(pg_restore --list "$DUMP_FILE" 2>/dev/null | grep -c ';' || true)
else
  TOC_LINES="(pg_restore на хості немає — перевірить restore-drill)"
fi

echo
log "розмір:      $SIZE_HUMAN ($SIZE_BYTES байт)"
log "час:         ${ELAPSED}s"
log "TOC:         $TOC_LINES записів (pg_restore --list читається)"
echo
echo "✔ бекап готовий:"
echo "$DUMP_FILE"

# Прибирання старих копій: тримаємо останні BACKUP_KEEP (типово 14 — два тижні
# при нічному розкладі). Нуль вимикає прибирання.
BACKUP_KEEP="${BACKUP_KEEP:-14}"
# Без mapfile і масивів: на macOS /bin/bash це 3.2, і bash-4-only синтаксис
# там просто не запуститься.
if [ "$BACKUP_KEEP" -gt 0 ]; then
  ls -1t "$BACKUP_DIR"/${DB_NAME}_*.dump 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | while read -r old; do
    [ -n "$old" ] || continue
    rm -f "$old" "$old.checksum" "$old.sha256"
    log "прибрано старий бекап: $(basename "$old")"
  done
fi
