# myadmin

Admin dashboard implemented as a modular Flask application.

## Architecture

- `app/` contains the Flask app factory, route modules, services, API client, and task helpers.
- `app/routes/` registers the dashboard, messages, send-money, and settings endpoints.
- `app/services/` contains domain logic for dashboard aggregation, messages, settings, and transfers.
- `app/clients/api_client.py` centralizes upstream HTTP calls and prefers `HTTPX` with connection pooling.
- `app/extensions.py` provides cache and Celery integration with safe fallbacks for local development.
- `templates/` contains the shared app shell and page partials.
- `static/` contains shared and page-specific frontend assets.
- `wsgi.py` is the Gunicorn entrypoint.
- `celery_app.py` exposes cache warming tasks for a worker process.
- `deploy/nginx/transferflow.conf` contains an example Nginx reverse-proxy config.
- `docs/dashboard-api-contract.md` documents the dashboard response contract.

## Important files

- `app/__init__.py`
- `app/config.py`
- `app/extensions.py`
- `app/clients/api_client.py`
- `app/services/dashboard.py`
- `app/services/messages.py`
- `app/services/settings.py`
- `app/services/transfers.py`
- `app/routes/dashboard.py`
- `app/routes/send_money.py`
- `app/routes/messages.py`
- `app/routes/settings.py`
- `app.py`
- `wsgi.py`
- `celery_app.py`
- `gunicorn.conf.py`
- `docker-compose.redis.yml`
- `templates/base_app.html`
- `templates/partials/dashboard_content.html`
- `templates/partials/messages_content.html`
- `templates/partials/send_money_content.html`
- `templates/partials/settings_content.html`
- `static/ux-enhancements.js`
- `static/dashboard-page.js`

## Environment variables

Set these in `.env`:

```env
API_BASE_URL=https://your-main-api-host/api
SENDER_CONFIG_API_URL=https://your-main-api-host/api/sender-configurations
SEND_MONEY_API_URL=https://your-main-api-host/api/send-money
APP_TIMEZONE=Africa/Dar_es_Salaam
FLASK_SECRET_KEY=change-this
REDIS_URL=redis://127.0.0.1:6379/0
CELERY_BROKER_URL=redis://127.0.0.1:6379/0
CELERY_RESULT_BACKEND=redis://127.0.0.1:6379/0
USE_CELERY_CACHE_WARMING=true
DASHBOARD_REFRESH_LOCK_TTL=120
HTTPX_TIMEOUT_SECONDS=12
HTTPX_CONNECT_TIMEOUT_SECONDS=5
HTTPX_MAX_CONNECTIONS=20
HTTPX_MAX_KEEPALIVE_CONNECTIONS=10
GUNICORN_WORKERS=4
GUNICORN_BIND=127.0.0.1:8000
CACHE_DEFAULT_TTL=180
DASHBOARD_CACHE_TTL=180
MESSAGES_CACHE_TTL_SECONDS=120
SENDER_CONFIG_CACHE_TTL_SECONDS=180
TRANSACTION_CACHE_TTL_SECONDS=180
TRANSACTION_FETCH_WORKERS=6
```

Notes:

- `API_BASE_URL` is used for transactions and messages.
- `SENDER_CONFIG_API_URL` is used by the settings page.
- `SEND_MONEY_API_URL` is used by the send-money flow.
- `REDIS_URL` is used by Flask-Caching and Celery when Redis is available.
- `docker-compose.redis.yml` is the recommended local Redis setup.
- `USE_CELERY_CACHE_WARMING` makes dashboard stale-cache refresh dispatch through Celery first, with a local fallback if the broker is unavailable.
- `DASHBOARD_REFRESH_LOCK_TTL` prevents duplicate background dashboard refresh jobs from being queued repeatedly.
- `HTTPX_*` values tune the pooled upstream client.
- `GUNICORN_*` values control production worker settings.
- `CACHE_DEFAULT_TTL`, `DASHBOARD_CACHE_TTL`, `MESSAGES_CACHE_TTL_SECONDS`, and `SENDER_CONFIG_CACHE_TTL_SECONDS` control shared cache freshness.
- `TRANSACTION_CACHE_TTL_SECONDS` controls how long dashboard transaction data stays fresh before a background refresh starts.
- `TRANSACTION_FETCH_WORKERS` controls how many upstream transaction pages are fetched in parallel when the dashboard cache is rebuilt.

## Local setup

### 1. Install Python dependencies

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

### 2. Start Redis locally

Recommended local setup:

```bash
docker compose -f docker-compose.redis.yml up -d
```

Make sure Docker Desktop or the local Docker daemon is running first.

Check Redis status:

```bash
docker compose -f docker-compose.redis.yml ps
```

If you already have Redis installed locally, use:

```bash
redis-server --appendonly yes
```

### 3. Start the Flask app (development)

```bash
./.venv/bin/python app.py
```

Default dev URL:

- `http://127.0.0.1:5000`

If port `5000` is occupied:

```bash
./.venv/bin/flask --app app:app run --debug -p 5001
```

### 4. Start Gunicorn (production-style local run)

```bash
./.venv/bin/gunicorn -c gunicorn.conf.py wsgi:application
```

### 5. Start Celery worker

```bash
./.venv/bin/celery -A celery_app.celery worker --loglevel=info
```

### 6. Stop local Redis

If you used Docker:

```bash
docker compose -f docker-compose.redis.yml down
```

## Routes

- `/`
- `/dashboard`
- `/messages`
- `/send-money`
- `/settings`

## Stack

- Web app: Flask
- App server: Gunicorn
- Reverse proxy: Nginx
- Cache: Flask-Caching with Redis when available
- HTTP client: HTTPX
- Async jobs: Celery

## Upstream endpoints used by the app

- `GET` messages and transactions via `API_BASE_URL`
- sender configurations via `SENDER_CONFIG_API_URL`
- send-money requests via `SEND_MONEY_API_URL`

## Notes

- There is no Node.js runtime in this repository anymore.
- The previous Express implementation and npm dependencies were removed.
- The checked-in `.env` now targets local Redis at `127.0.0.1:6379` for cache and Celery broker/backend.
- If Redis is not running, the app degrades to in-process cache and thread-based dashboard refresh until Redis is available.
