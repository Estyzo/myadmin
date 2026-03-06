# myadmin

Admin dashboard project with:
- a Flask UI in [app.py](/Users/hassanlugelo/Downloads/myadmin/app.py)
- a single-file Node.js API in [index.js](/Users/hassanlugelo/Downloads/myadmin/index.js)

The dashboard statistics are calculated server-side in the Node API and consumed by Flask through `DASHBOARD_API_URL`.

## Architecture

- `Flask UI`: renders dashboard, messages, send money, and settings pages
- `Node API`: owns transaction CRUD, sender configuration endpoints, reports, auth, and dashboard aggregation
- `MySQL`: backing store for transactions and related operational data

Dashboard flow:
- Flask calls `GET /api/dashboard-data` on the Node API
- Node queries MySQL and returns the dashboard contract
- Flask renders the returned data into the dashboard UI

## Important files

- [app.py](/Users/hassanlugelo/Downloads/myadmin/app.py): Flask web app
- [index.js](/Users/hassanlugelo/Downloads/myadmin/index.js): single-file Node API, including dashboard endpoint
- [.env.example](/Users/hassanlugelo/Downloads/myadmin/.env.example): Flask environment variables
- [requirements.txt](/Users/hassanlugelo/Downloads/myadmin/requirements.txt): Flask dependencies

## Dashboard endpoint

Implemented directly in [index.js](/Users/hassanlugelo/Downloads/myadmin/index.js#L962).

Routes:
- `GET /health/dashboard`
- `GET /api/dashboard-data`

The dashboard endpoint supports:
- period filtering: `today`, `all`
- search: `q`
- filters: `operator`, `operation`
- sorting: `sort_by`, `sort_dir`
- pagination: `page`, `per_page`
- optional export support: `include_filtered=1`

The dashboard cache is invalidated automatically when new transactions are inserted through:
- `POST /api/transactions`
- `POST /api/postTransaction`

## Flask environment variables

Set these in `.env`:

```env
API_BASE_URL=https://your-main-api-host/api
DASHBOARD_API_URL=http://127.0.0.1:3000/api/dashboard-data
SENDER_CONFIG_API_URL=https://your-main-api-host/api/sender-configurations
SEND_MONEY_API_URL=https://your-main-api-host/api/send-money
APP_TIMEZONE=Africa/Dar_es_Salaam
FLASK_SECRET_KEY=change-this
```

Current example values are in [.env.example](/Users/hassanlugelo/Downloads/myadmin/.env.example).

## Node API configuration

The Node API currently keeps its configuration inline in [index.js](/Users/hassanlugelo/Downloads/myadmin/index.js#L13) under `CONFIG`.

That includes:
- `PORT`
- MySQL connection details
- JWT secrets
- CORS settings
- dashboard cache settings

Before production deployment, move the following out of source code and into environment variables:
- database host, user, password, database name
- JWT secret
- refresh JWT secret

Keeping production secrets in `index.js` is not acceptable long-term.

## Local setup

### 1. Install Flask dependencies

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

### 2. Install Node dependencies

If you do not already have them installed in your API project:

```bash
npm install express mysql2 cors bcrypt jsonwebtoken
```

### 3. Start the Node API

```bash
node index.js
```

Default Node port:
- `3000`

### 4. Start the Flask app

```bash
./.venv/bin/python app.py
```

Default Flask dev URL:
- [http://127.0.0.1:5000](http://127.0.0.1:5000)

If port `5000` is occupied, start Flask on another port:

```bash
./.venv/bin/flask --app app run --debug -p 5001
```

## Production notes

Current deployment model:
- run the Node API
- run the Flask UI

Why both are required:
- the Flask app renders the web UI
- the Node API provides dashboard data and operational endpoints

Recommended production direction:
- keep dashboard aggregation in the Node API
- keep Flask as the presentation layer
- run Flask behind a production WSGI server instead of the Flask dev server
- move Node config secrets to environment variables

## Pages

Flask routes currently include:
- `/`
- `/messages`
- `/send-money`
- `/settings`

## API endpoints used by Flask

Flask depends on these upstream endpoints:
- `GET /api/dashboard-data` via `DASHBOARD_API_URL`
- `GET /api/sender-configurations` via `SENDER_CONFIG_API_URL`
- send-money endpoint via `SEND_MONEY_API_URL`
- transaction/message endpoints under `API_BASE_URL`

## Notes

- The dashboard API is now maintained in a single file: [index.js](/Users/hassanlugelo/Downloads/myadmin/index.js)
- Temporary dashboard reference modules were removed from this repo after the inline integration
