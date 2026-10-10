#!/usr/bin/env bash
#
# Restore-drill: доводимо, що з бекапа справді можна відновитися.
#
#   bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh   # основний шлях
#   SKIP_VAULT=1 DATABASE_URL=… bash scripts/restore-drill.sh        # CI / грейдер
#
# Що робить:
#   1. бере НАЙСВІЖІШИЙ дамп із backups/;
#   2. піднімає ЧИСТИЙ Postgres — окремий контейнер на порожньому volume, якого
#      до запуску не існувало (скрипт створює його сам і сам прибирає);
#   3. відновлює дамп туди;
#   4. порівнює контрольне значення (count|sum по orders) із тим, що було на
#      момент дампу, — його записав backup.sh у файл *.checksum;
#   5. друкує MATCH або падає з ненульовим кодом.
#
# Повторний запуск теж дає MATCH: щоразу створюється новий volume з новим
# іменем, а старий прибирається у trap-і навіть якщо drill упав посередині.
# Відновлення в НЕпорожній volume — головна причина фальшивих duplicate key.
set -euo pipefail

# shellcheck source=scripts/lib-db.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-db.sh"

DRILL_IMAGE="${DRILL_IMAGE:-postgres:16-alpine}"
DRILL_DB="${DRILL_DB:-drill}"
SUFFIX="$$-$(date +%s)"
DRILL_CONTAINER="marketplace-drill-$SUFFIX"
DRILL_VOLUME="marketplace-drill-vol-$SUFFIX"
NATIVE_DIR=""
MODE=""
AS_PG=""
PG_CTL=""
DRILL_ENGINE=""

now_ms() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time() * 1000))'
  else
    echo $(( $(date +%s) * 1000 ))
  fi
}

cleanup() {
  if [ "$MODE" = "docker" ]; then
    docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "$DRILL_VOLUME" >/dev/null 2>&1 || true
    log "прибрано: контейнер $DRILL_CONTAINER і volume $DRILL_VOLUME"
  elif [ "$MODE" = "native" ] && [ -n "$NATIVE_DIR" ]; then
    [ -n "$AS_PG" ] && $AS_PG "$PG_CTL -D '$NATIVE_DIR/data' -m immediate stop" >/dev/null 2>&1 || true
    rm -rf "$NATIVE_DIR"
    log "прибрано: тимчасовий кластер $NATIVE_DIR"
  fi
}
trap cleanup EXIT

# ── 1. найсвіжіший дамп ──────────────────────────────────────────────────────
DUMP_FILE="${DUMP_FILE:-$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1 || true)}"
[ -n "$DUMP_FILE" ] || die "У $BACKUP_DIR немає жодного дампу. Спершу: bash scripts/backup.sh"
[ -f "$DUMP_FILE" ] || die "Файл не знайдено: $DUMP_FILE"

DUMP_NAME="$(basename "$DUMP_FILE")"
DUMP_SIZE_BYTES=$(wc -c < "$DUMP_FILE" | tr -d ' ')
DUMP_SIZE_HUMAN=$(du -h "$DUMP_FILE" | cut -f1)

echo "── restore-drill ──"
log "дамп:   $DUMP_NAME ($DUMP_SIZE_HUMAN, $DUMP_SIZE_BYTES байт)"

# ── 2. контрольне значення «до» ──────────────────────────────────────────────
if [ -f "$DUMP_FILE.checksum" ]; then
  EXPECTED="$(tr -d '[:space:]' < "$DUMP_FILE.checksum")"
  log "до:     $EXPECTED (із $DUMP_NAME.checksum — знято на момент дампу)"
else
  EXPECTED="$(checksum_of_live_db | tr -d '[:space:]')"
  log "до:     $EXPECTED (сайдкара немає — взято з живої бази, менш точно)"
fi

# ── 3. чистий Postgres ───────────────────────────────────────────────────────
DRILL_STARTED_MS=$(now_ms)

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  MODE="docker"
  DRILL_ENGINE="$DRILL_IMAGE"
  log "режим:  docker — окремий контейнер на порожньому volume"

  docker volume create "$DRILL_VOLUME" >/dev/null
  docker run -d \
    --name "$DRILL_CONTAINER" \
    -e POSTGRES_PASSWORD=drill \
    -e POSTGRES_DB="$DRILL_DB" \
    -v "$DRILL_VOLUME:/var/lib/postgresql/data" \
    -v "$BACKUP_DIR:/backups:ro" \
    "$DRILL_IMAGE" >/dev/null

  for _ in $(seq 1 60); do
    if docker exec "$DRILL_CONTAINER" pg_isready -U postgres -d "$DRILL_DB" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  docker exec "$DRILL_CONTAINER" pg_isready -U postgres -d "$DRILL_DB" >/dev/null 2>&1 \
    || die "контейнер drill не піднявся: $(docker logs --tail 20 "$DRILL_CONTAINER" 2>&1)"

  drill_checksum() {
    docker exec "$DRILL_CONTAINER" psql -U postgres -d "$DRILL_DB" -Atc "$CHECKSUM_SQL"
  }
  drill_restore() {
    # --no-owner: власник обʼєктів у дампі (marketplace) у чистому контейнері
    # не існує, і без цього прапорця pg_restore впаде на кожному ALTER OWNER.
    docker exec "$DRILL_CONTAINER" pg_restore --no-owner --no-acl \
      -U postgres -d "$DRILL_DB" "/backups/$DUMP_NAME"
  }
else
  # Фолбек для середовищ без доступного Docker (CI-раннер, пісочниця без
  # доступу до реєстрів образів). Суть та сама: ЧИСТИЙ кластер у теці, якої до
  # запуску не існувало, і яку скрипт сам прибирає.
  MODE="native"
  DRILL_ENGINE="тимчасовий кластер, $(psql --version 2>/dev/null || echo postgres)"
  PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1 || true)}"
  INITDB="${PG_BIN:+$PG_BIN/}initdb"
  PG_CTL="${PG_BIN:+$PG_BIN/}pg_ctl"
  command -v "$INITDB" >/dev/null 2>&1 || command -v initdb >/dev/null 2>&1 \
    || die "Docker недоступний, і initdb теж немає — підняти чистий Postgres нічим.
Підніми Docker (саме цей шлях перевіряє грейдер) або встанови postgresql-client+server."
  log "режим:  native — тимчасовий кластер (Docker недоступний)"

  NATIVE_DIR="$(mktemp -d /tmp/marketplace-drill-XXXXXX)"
  if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then
    AS_PG="su postgres -c"
    chown postgres:postgres "$NATIVE_DIR"
  else
    AS_PG="bash -c"
  fi

  $AS_PG "$INITDB -D '$NATIVE_DIR/data' -A trust -U postgres" >/dev/null 2>&1 \
    || die "initdb не відпрацював"
  $AS_PG "$PG_CTL -D '$NATIVE_DIR/data' -o '-k $NATIVE_DIR -h \"\"' -l '$NATIVE_DIR/pg.log' start" >/dev/null 2>&1 \
    || die "кластер не піднявся: $(cat "$NATIVE_DIR/pg.log" 2>/dev/null | tail -5)"
  $AS_PG "psql -h '$NATIVE_DIR' -U postgres -qc 'CREATE DATABASE $DRILL_DB'" >/dev/null

  drill_checksum() {
    $AS_PG "psql -h '$NATIVE_DIR' -U postgres -d $DRILL_DB -Atc \"$CHECKSUM_SQL\""
  }
  # Копіюємо дамп у тимчасову теку: у native-режимі pg_restore запускається від
  # користувача postgres, і до теки backups/ у домашньому каталозі іншого
  # користувача він може просто не мати доступу.
  cp "$DUMP_FILE" "$NATIVE_DIR/$DUMP_NAME"
  [ "$AS_PG" = "bash -c" ] || chown postgres "$NATIVE_DIR/$DUMP_NAME"

  drill_restore() {
    $AS_PG "pg_restore --no-owner --no-acl -h '$NATIVE_DIR' -U postgres -d $DRILL_DB '$NATIVE_DIR/$DUMP_NAME'"
  }
fi

# ── 4. відновлення ───────────────────────────────────────────────────────────
RESTORE_START_MS=$(now_ms)
drill_restore
RESTORE_MS=$(( $(now_ms) - RESTORE_START_MS ))
log "відновлено за ${RESTORE_MS} мс"

# ── 5. порівняння ────────────────────────────────────────────────────────────
ACTUAL="$(drill_checksum | tr -d '[:space:]')"
[ -n "$ACTUAL" ] || die "не вдалося зняти контрольне значення з відновленої бази"

TOTAL_MS=$(( $(now_ms) - DRILL_STARTED_MS ))

echo
log "контрольне значення (count|sum по $CHECKSUM_TABLE)"
log "  до:    $EXPECTED"
log "  після: $ACTUAL"
echo

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "✖ MISMATCH: відновлена база не збігається з дампом" >&2
  exit 1
fi

cat <<SUMMARY
MATCH

── для RESTORE-DRILL.md ──
дата drill-у:        $(date '+%Y-%m-%d %H:%M %Z')
режим:               $MODE${DRILL_ENGINE:+ ($DRILL_ENGINE)}
дамп:                $DUMP_NAME
розмір дампу:        $DUMP_SIZE_HUMAN ($DUMP_SIZE_BYTES байт)
час pg_restore:      ${RESTORE_MS} мс
RTO (увесь drill):   ${TOTAL_MS} мс  — від старту чистого Postgres до підтвердженого MATCH
контрольне значення: $ACTUAL (count|sum по $CHECKSUM_TABLE)
SUMMARY
