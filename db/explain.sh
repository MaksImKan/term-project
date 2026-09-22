#!/usr/bin/env bash
#
# Прогін EXPLAIN (ANALYZE, BUFFERS) для q1..q4 проти стенда з docker-compose.
#
# Кожен запит виконується RUNS разів (типово 3), друкується ОСТАННІЙ прогін:
# перший виклик q4 після CREATE INDEX може піти по холодному GIN і показати
# число в рази гірше за справжнє.
#
#   bash db/explain.sh          # усі чотири
#   bash db/explain.sh 4        # тільько q4
#   RUNS=1 bash db/explain.sh   # по одному прогону (для EXPLAIN «до індексів»)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNS="${RUNS:-3}"
QUERIES=("$@")
[ ${#QUERIES[@]} -eq 0 ] && QUERIES=(1 2 3 4)

cd "$ROOT"
for n in "${QUERIES[@]}"; do
  sql="$(cat "db/queries/q$n.sql")"
  out=""
  for _ in $(seq 1 "$RUNS"); do
    out="$(docker compose exec -T db psql -U marketplace -d marketplace \
             -c "EXPLAIN (ANALYZE, BUFFERS) $sql")"
  done
  echo "================ q$n ================"
  echo "$out"
  echo
done
