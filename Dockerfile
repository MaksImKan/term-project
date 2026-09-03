# Мінімальний single-stage образ (за зразком ДЗ #5).
# Головне правило: у шарах образу немає ЖОДНОГО секрету.
#  - .env та secrets/ виключені через .dockerignore;
#  - жодного ENV з паролем: конфіг приходить у рантаймі (env), а пароль БД —
#    з примонтованого файла-секрета (docker secret / volume / k8s secret).
FROM node:22-alpine

WORKDIR /app

# Спершу маніфести — щоб шар з npm ci кешувався між збірками.
COPY package.json package-lock.json ./
RUN npm ci

# Далі — код. Що саме НЕ копіюється, вирішує .dockerignore.
COPY . .

RUN npm run build

EXPOSE 3000

# Не npm start: у продакшн-образі збірка вже зроблена на етапі build.
CMD ["node", "dist/main.js"]
