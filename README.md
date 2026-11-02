# Business OS — сервер (API)

Node.js 20.12+ · Express · MongoDB (Mongoose). Самодостатній проєкт: нічого, крім цієї папки, не потрібно.

## Локальний запуск
```bash
npm install
docker compose up -d        # MongoDB як replica set (потрібен для транзакцій)
cp .env.example .env        # задайте JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm run migrate             # колекції та індекси
npm run seed:admin          # створює власника (логін/пароль з .env)
npm run dev                 # http://localhost:4000, перевірка: /api/health
npm test                    # тести бізнес-логіки
```
Без Docker використайте MongoDB Atlas (безкоштовний кластер M0 — уже replica set) і вставте його рядок у `MONGODB_URI`.

## Розгортання (Render / Railway / Fly.io / будь-який Node-хостинг)
1. **База:** створіть кластер у MongoDB Atlas, дозвольте доступ з IP хостингу (Network Access), скопіюйте рядок підключення.
2. **Сервіс:** підключіть репозиторій із цією папкою. Build: `npm ci --omit=dev`, Start: `node src/index.js`. Є `render.yaml` і `Dockerfile`.
3. **Змінні середовища:**

| Змінна | Значення |
|---|---|
| `MONGODB_URI` | рядок з Atlas |
| `JWT_SECRET` | випадковий рядок від 32 символів |
| `NODE_ENV` | `production` |
| `CLIENT_ORIGIN` | адреса фронтенду, напр. `https://my-shop.netlify.app` |
| `CROSS_SITE` | `true`, якщо фронтенд і API на різних доменах без проксі |
| `UPLOAD_DIR` | шлях постійного диска для файлів |

4. **Одноразово** (у консолі сервісу або локально з тими самими змінними): `npm run migrate`, потім `npm run seed:admin` з `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

### З'єднання з фронтендом на Netlify
Варіант А (рекомендований): у фронтенді в `netlify.toml` проксуйте API, тоді cookie працює без налаштувань, `CROSS_SITE=false`:
```toml
[[redirects]]
  from = "/api/*"
  to = "https://ВАШ-СЕРВІС.onrender.com/api/:splat"
  status = 200
  force = true
```
Варіант Б: фронтенд звертається до API напряму — тоді `CROSS_SITE=true`, `CLIENT_ORIGIN=https://ваш-сайт.netlify.app`, а у фронтенді адресу API треба додати перед `/api` у `client/src/lib/api.js`.

### Файли
Фото й документи зберігаються в `UPLOAD_DIR` на диску. На безкоштовних планах диск стирається при перезапуску — підключіть постійний диск або попросіть мене перенести файли у S3/R2.

## API
`/api/auth/login|logout|me` · `/api/products` (+ `/:id`, `/:id/archive|restore|history`) · `/api/inventory/movements|alerts` · `/api/attachments` · `/api/categories|suppliers|warehouses` · `/api/users` (лише owner). Усе, крім `/api/health` і входу, потребує сесії.

Ролі: `owner` (усе), `manager` (змінює дані), `viewer` (лише читає).

## Статус перевірки
Тести логіки, завантаження сервера й валідація запитів перевірені. Транзакції та запити до бази не запускалися на живій MongoDB — перший запуск її покаже.
