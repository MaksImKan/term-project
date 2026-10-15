#!/usr/bin/env bash
# ДЗ-16: локальна демонстрація гейта can-i-deploy на справжньому Pact Broker.
#
#   bash scripts/pact-gate-demo.sh
#
# Що відбувається (та сама послідовність, що в .github/workflows/contract.yml):
#
#   1. compose up          — піднімаємо брокер зі стенда проєкту
#   2. публікація контракту — pacts/*.json їде в брокер як версія консюмера
#   3. verify:provider      — справжній застосунок проти контракту,
#                             publishVerificationResult: true
#   5. can-i-deploy         — ПЕРШИЙ раз, ще до тегу: deployable = null,
#                             unknown = 1 (у prod немає провайдера, з яким
#                             порівнювати)
#   4. тег prod             — PUT тега prod на ВЕРСІЮ ПРОВАЙДЕРА: саме так
#                             брокер дізнається, що в prod стоїть ця версія
#   5. can-i-deploy         — ДРУГИЙ раз, уже з тегом: deployable = true
#
# Публікація, тег і сам гейт — звичайний HTTP API брокера через curl: жодного
# pact-broker CLI, жодних ruby-гемів, нічого ставити не треба.
#
# Адреса брокера: PACT_BROKER_URL, типово локальний стенд. Токен (на справжньому
# брокері) — PACT_BROKER_TOKEN; у репозиторії його немає, локально його підкладає
# сховище ДЗ-11, у CI — secrets GitHub.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BROKER="${PACT_BROKER_URL:-http://127.0.0.1:9292}"
CONSUMER="marketplace-web"
PROVIDER="marketplace-api"
PACT_FILE="pacts/${CONSUMER}-${PROVIDER}.json"
TAG="${PACT_PROD_TAG:-prod}"

# Версія — коміт плюс номер прогону. Суфікс потрібен саме демо: воно показує
# стан «у prod ще нічого немає», а після першого прогону версія цього коміту вже
# протегована prod — і другий запуск показав би одразу зелений гейт. У CI
# суфікса немає: там версія = github.sha, по одній на коміт.
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 0.0.0-local)"
RUN="${PACT_DEMO_RUN:-$(date +%H%M%S)}"
CONSUMER_VERSION="${CONSUMER_VERSION:-$SHA-$RUN}"
PROVIDER_VERSION="${PROVIDER_VERSION:-$SHA-$RUN}"

# Токен передаємо заголовком лише якщо він є: на локальному брокері авторизації
# немає, і порожній `Authorization: Bearer` деякі версії відхиляють.
AUTH=()
if [ -n "${PACT_BROKER_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer ${PACT_BROKER_TOKEN}")
fi

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Вивід can-i-deploy у двох рядках: сирий summary (щоб було видно deployable і
# unknown як є) і людська причина. Парсимо node-ом, а не jq: node у проєкті вже
# є, jq на машині може не бути.
summary_of() {
  node -e '
    const fs = require("node:fs");
    const body = fs.readFileSync(process.argv[1], "utf8");
    let json;
    try { json = JSON.parse(body); } catch { console.log(body.slice(0, 400)); process.exit(0); }
    const s = json.summary ?? {};
    console.log("  summary: " + JSON.stringify(s));
    if (s.reason) console.log("  reason:  " + s.reason);
    process.exit(s.deployable === true ? 0 : 1);
  ' "$1"
}

can_i_deploy() {
  local out="$1"
  curl -sS "${AUTH[@]}" -G "$BROKER/can-i-deploy" \
    --data-urlencode "pacticipant=$CONSUMER" \
    --data-urlencode "version=$CONSUMER_VERSION" \
    --data-urlencode "to=$TAG" \
    -o "$out"
}

# ── 1. compose up ────────────────────────────────────────────────────────────
say "1/5 Брокер: docker compose up -d --wait pact-broker"
if [ "$BROKER" = "http://127.0.0.1:9292" ] || [ "$BROKER" = "http://localhost:9292" ]; then
  docker compose up -d --wait pact-broker
else
  echo "  PACT_BROKER_URL=$BROKER — зовнішній брокер, нічого не підіймаємо"
fi

# Healthcheck compose уже зелений, але heartbeat перепитуємо: якщо брокер
# зовнішній, --wait не виконувався зовсім.
for _ in $(seq 1 60); do
  if curl -fsS "${AUTH[@]}" "$BROKER/diagnostic/status/heartbeat" >/dev/null 2>&1; then
    echo "  heartbeat OK: $BROKER"
    break
  fi
  sleep 2
done
curl -fsS "${AUTH[@]}" "$BROKER/diagnostic/status/heartbeat" >/dev/null

# ── 2. публікація контракту ──────────────────────────────────────────────────
say "2/5 Публікація контракту: $PACT_FILE -> $CONSUMER@$CONSUMER_VERSION"
if [ ! -f "$PACT_FILE" ]; then
  echo "  контракту ще немає — генеруємо: npm run test:contract"
  npm run --silent test:contract
fi
curl -sS -f "${AUTH[@]}" -X PUT \
  -H 'Content-Type: application/json' \
  --data-binary "@$PACT_FILE" \
  "$BROKER/pacts/provider/$PROVIDER/consumer/$CONSUMER/version/$CONSUMER_VERSION" \
  -o /tmp/pact-publish.json
echo "  опубліковано"

# ── 3. provider verification з публікацією результату ────────────────────────
say "3/5 Provider verification (publishVerificationResult: true), версія $PROVIDER_VERSION"
PACT_BROKER_URL="$BROKER" PROVIDER_VERSION="$PROVIDER_VERSION" npm run --silent verify:provider

# ── 5 (до тегу). Гейт відповідає «не знаю» ───────────────────────────────────
say "5/5 can-i-deploy ДО тегу $TAG (очікуємо deployable: null, unknown: 1)"
can_i_deploy /tmp/can-i-deploy-before.json
set +e
summary_of /tmp/can-i-deploy-before.json
BEFORE=$?
set -e
if [ "$BEFORE" -eq 0 ]; then
  echo "  ПОМИЛКА: до тегу гейт не мав бути зеленим."
  echo "  Схоже, версію $PROVIDER_VERSION уже протеговано $TAG у попередньому прогоні."
  echo "  Візьміть іншу версію: PACT_DEMO_RUN=\$(date +%s) bash scripts/pact-gate-demo.sh"
  exit 1
fi
echo "  -> гейт НЕ пускає: у $TAG немає версії провайдера, з якою порівнювати"

# ── 4. тег prod на версію провайдера ─────────────────────────────────────────
say "4/5 Тег $TAG на версію провайдера: $PROVIDER@$PROVIDER_VERSION"
curl -sS -f "${AUTH[@]}" -X PUT -H 'Content-Type: application/json' -d '{}' \
  "$BROKER/pacticipants/$PROVIDER/versions/$PROVIDER_VERSION/tags/$TAG" \
  -o /tmp/pact-tag.json
echo "  протеговано"

# ── 5 (після тегу). Гейт зелений ─────────────────────────────────────────────
say "5/5 can-i-deploy ПІСЛЯ тегу $TAG (очікуємо deployable: true)"
can_i_deploy /tmp/can-i-deploy-after.json
if ! summary_of /tmp/can-i-deploy-after.json; then
  echo "  ПОМИЛКА: гейт не зелений — деплоїти не можна."
  exit 1
fi
echo "  -> гейт пускає: контракт консюмера верифіковано версією провайдера в $TAG"

say "Готово. Обидва стани гейта показані вище."
