# myadmin

Admin dashboard implemented as a Flask application.

## Architecture

- `app.py` serves the dashboard, messages, send-money, and settings pages.
- `static/` contains shared and page-specific frontend assets.
- `templates/` contains the shared app shell and page partials.
- `docs/dashboard-api-contract.md` documents the dashboard response contract.

The app builds dashboard data internally inside Flask.

## Important files

- `app.py`
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
```

Notes:

- `API_BASE_URL` is used for transactions and messages.
- `SENDER_CONFIG_API_URL` is used by the settings page.
- `SEND_MONEY_API_URL` is used by the send-money flow.

## Local setup

### 1. Install Python dependencies

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

### 2. Start the Flask app

```bash
./.venv/bin/python app.py
```

Default dev URL:

- `http://127.0.0.1:5000`

If port `5000` is occupied:

```bash
./.venv/bin/flask --app app run --debug -p 5001
```

## Routes

- `/`
- `/dashboard`
- `/messages`
- `/send-money`
- `/settings`

## Upstream endpoints used by Flask

- `GET` messages and transactions via `API_BASE_URL`
- sender configurations via `SENDER_CONFIG_API_URL`
- send-money requests via `SEND_MONEY_API_URL`

## Notes

- There is no Node.js runtime in this repository anymore.
- The previous Express implementation and npm dependencies were removed.
