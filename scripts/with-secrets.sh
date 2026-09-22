#!/usr/bin/env bash
#
# Обгортка сховища секретів (ДЗ-11 → ДЗ-13).
#
# Ідея: жодна команда, що ходить у базу, не читає власний env-файл і не має
# зашитих креденшелів. Значення підкладає сховище безпосередньо в оточення
# дочірнього процесу — рівно так, як у проді це робить платформа.
#
#   bash scripts/with-secrets.sh dev  npm run migrate
#   bash scripts/with-secrets.sh prod node dist/report.js
#
# Перший аргумент — slug оточення у сховищі (dev | staging | prod), решта —
# команда. Без команди запускається застосунок.
#
# Креденшели самого сховища (токен машинної ідентичності й id проєкту) лежать
# у .secrets/infisical.env ПОЗА git — це єдиний секрет, який мусить існувати
# локально, щоб дістати всі інші.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_SLUG="${1:-dev}"; shift || true
[ "$#" -gt 0 ] || set -- npm run start

# грейдер не має доступу до сховища: значення вже в оточенні
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

CREDS="$ROOT/.secrets/infisical.env"

if [ ! -f "$CREDS" ]; then
  cat >&2 <<MSG
✖ Немає $CREDS — обгортка не знає, як автентифікуватись у сховищі.

Налаштування один раз:
  1) встанови CLI:      brew install infisical/get-cli/infisical
  2) створи машинну ідентичність у проєкті Infisical і поклади її сюди:
       mkdir -p .secrets
       cp .secrets/infisical.env.example .secrets/infisical.env
       \$EDITOR .secrets/infisical.env
  (.secrets/ у .gitignore — у репозиторій цей файл не потрапляє)

Якщо сховища немає під рукою (CI, грейдер), значення беруться з оточення:
  export DB_HOST=… DB_PORT=… DB_USER=… DB_PASSWORD=… DB_NAME=…
  export SKIP_VAULT=1
MSG
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "$CREDS"; set +a

if ! command -v infisical >/dev/null 2>&1; then
  echo "✖ Не знайдено infisical CLI. Встанови його або скористайся SKIP_VAULT=1." >&2
  exit 1
fi

: "${INFISICAL_PROJECT_ID:?у .secrets/infisical.env немає INFISICAL_PROJECT_ID}"

# Машинна ідентичність: обмінюємо client id/secret на токен саме тут, щоб
# токен жив рівно стільки, скільки одна команда, і не осідав у shell-історії.
if [ -z "${INFISICAL_TOKEN:-}" ]; then
  : "${INFISICAL_CLIENT_ID:?потрібен INFISICAL_TOKEN або INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET}"
  : "${INFISICAL_CLIENT_SECRET:?потрібен INFISICAL_CLIENT_SECRET}"
  INFISICAL_TOKEN="$(infisical login --method=universal-auth \
    --client-id="$INFISICAL_CLIENT_ID" \
    --client-secret="$INFISICAL_CLIENT_SECRET" \
    --silent --plain)"
  export INFISICAL_TOKEN
fi

exec infisical run \
  --projectId="$INFISICAL_PROJECT_ID" \
  --env="$ENV_SLUG" \
  --path="${INFISICAL_PATH:-/}" \
  -- "$@"
