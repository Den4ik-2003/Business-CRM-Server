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
| `CROSS_SITE` | `true`, якщо фронтенд і API на різних доменах без проксі (для cookie потрібні HTTPS і дозволений `CLIENT_ORIGIN`) |
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
`/api/auth/login|logout|me` · `/api/products` (+ `/:id`, `/:id/archive|restore|history`) · `/api/inventory/movements|alerts` · `/api/attachments` · `/api/categories|suppliers|warehouses` · `/api/users` (лише owner). Усе, крім `/api/health` і входу, потребує сесії. Сервер підтримує два способи авторизації:
- HttpOnly cookie `bos_token` (основний підтримуваний механізм). JWT діє до 8 годин; вихід і зміна пароля/ролі відкликають попередні сесії. Не зберігайте токени у localStorage та не передавайте їх у URL.

Ролі: `owner` (усе), `manager` (змінює дані), `viewer` (лише читає).

## Статус перевірки
Тести логіки, завантаження сервера й валідація запитів перевірені. Транзакції та запити до бази не запускалися на живій MongoDB — перший запуск її покаже.


## Business CRM feature set

This server package retains the existing authenticated API for products, SKU/barcode search, categories/subcategories, stock movements, price history, attachments, sales, expenses, and analytics. The frontend package adds product ranking/search presentation, printable Code 39 labels, and a persistent light/dark theme toggle. The barcode label uses Code 39 and is generated from the product barcode (SKU fallback).


## Додатково: замовлення та облік
- Продаж створюється зі статусом «Нове» без списання залишку.
- Фоновий таймер переводить нові продажі у «Відправлено» приблизно через 2,5 години.
- Після отримання покупцем товар списується зі складу через журнал рухів; відмова не списує залишок.
- Нагадування для статусів «Відправлено» та «Ще у відділенні» повторюються кожні 3 дні, доки статус не змінено.
- Канал продажу зберігається окремо та агрегується в `/api/sales/analytics/summary`.
- Для товарів доступні обране та дата переходу залишку в нуль для нагадування через 3 дні.


## Облік зацікавленості товарами

Після оновлення backend запустіть штатну міграцію/синхронізацію індексів:

```bash
npm run migrate
```

Міграція створює довідники за замовчуванням (Низький/Середній/Високий/Гарячий з вагами 20/50/80/100 та базові канали Instagram, Threads, OLX, TikTok, Facebook, Telegram, Інший). Їх можна змінювати в CRM у розділі «Довідники».

API: `/api/interest-levels`, `/api/interest-channels`, `/api/interests/:productId` та `/api/interests/analytics/summary`. Історія зацікавленості зберігається окремо від товарів і не втрачається при архівації товару.


## Security hardening (2026-11)
- Для production обов’язково задайте `JWT_SECRET` випадковим значенням щонайменше 32 символи, `CLIENT_ORIGIN` точним origin фронтенду (без шляху/кінцевого `/`) та `NODE_ENV=production`.
- Якщо Netlify використовує `netlify/functions/api-proxy.mjs`, задайте в Netlify змінну `API_PROXY_URL` з HTTPS-адресою backend. У Render задайте `CLIENT_ORIGIN=https://<ваш-сайт>.netlify.app` і `CROSS_SITE=false` для same-origin proxy.
- На MongoDB Atlas створіть окремого DB-користувача лише для цієї CRM, обмежте Network Access IP-адресами backend, увімкніть TLS та резервні копії. Не використовуйте адміністратора Atlas як URI застосунку.
- Rate limiting у цьому пакеті зберігається в пам’яті одного процесу. Для кількох інстансів/production з autoscaling підключіть Redis-backed limiter.
- У Cloudinary unsigned upload preset обмежте формати, розмір, transformations та папку завантаження; не вважайте preset секретом.
- Локальна MongoDB у Docker опублікована лише на `127.0.0.1`; не відкривайте порт `27017` у публічний інтернет.
- Паролі нових облікових записів мають бути щонайменше 12 символів. Після оновлення попросіть користувачів встановити довгі унікальні паролі.
