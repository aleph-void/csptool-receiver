# CSP Violation Receiver

An Express 5 web application that receives, persists, and visualises Content Security Policy violation reports in real time. Built for [Aleph Void, LLC](https://alephvoid.com).

## Features

- **POST `/violations`** — accepts reports from both the legacy `report-uri` directive (`application/csp-report`) and the modern Reporting API `report-to` directive (`application/reports+json`)
- **GET `/violations`** — returns all violations since a given date (defaults to today) as JSON
- **Dashboard at `/`** — Vue 3 single-page app styled to match alephvoid.com; displays violations in real time via Socket.io
- **SQLite persistence** via `better-sqlite3` (WAL mode, zero external dependencies)
- **Socket.io** — pushes new violations to all connected dashboard clients the moment they are received

## Quick start

```bash
npm install
npm start
```

The server listens on port `3000` by default. Open `http://localhost:3000` to view the dashboard.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port to listen on |
| `DB_PATH` | `./violations.db` | Path to the SQLite database file |

## CSP configuration

### Modern Reporting API (`report-to`)

```http
Content-Security-Policy: default-src 'self'; report-to csp-endpoint
Reporting-Endpoints: csp-endpoint="https://your-host/violations"
```

### Legacy `report-uri`

```http
Content-Security-Policy: default-src 'self'; report-uri https://your-host/violations
```

## API

### `POST /violations`

Accepts `application/csp-report` or `application/reports+json` bodies. Returns `204 No Content` on success.

### `GET /violations?since=YYYY-MM-DD`

Returns a JSON array of violation objects ordered by `received_at` descending.

```bash
# All violations since a specific date
curl http://localhost:3000/violations?since=2026-04-01

# Today's violations (default)
curl http://localhost:3000/violations
```

**Violation object fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Auto-increment primary key |
| `received_at` | string (ISO 8601) | When the report was received |
| `document_uri` | string \| null | Page that had the violation |
| `violated_directive` | string \| null | The directive that was violated |
| `effective_directive` | string \| null | The effective directive |
| `blocked_uri` | string \| null | The resource that was blocked |
| `original_policy` | string \| null | The full CSP header value |
| `referrer` | string \| null | Referrer of the page |
| `status_code` | integer \| null | HTTP status of the page |
| `source_file` | string \| null | Source file of the violation |
| `line_number` | integer \| null | Line number |
| `column_number` | integer \| null | Column number |
| `raw` | string | Raw JSON of the original report body |

## Running tests

```bash
npm test
```

Tests cover:

- **`tests/db.test.js`** — SQLite layer: insert, query, ordering, isolation
- **`tests/app.test.js`** — HTTP routes: both report formats, field normalisation, Socket.io emit hook, GET filtering
- **`tests/socket.test.js`** — Socket.io: initial payload on connect, real-time `violation` events, multiple concurrent clients

## Docker

### Build and run

```bash
docker build -t csptool-receiver .
docker run -p 3000:3000 -v $(pwd)/data:/app/data \
  -e DB_PATH=/app/data/violations.db \
  csptool-receiver
```

### Docker Compose (recommended for production)

```yaml
services:
  csptool:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      DB_PATH: /app/data/violations.db
    restart: unless-stopped
```

```bash
docker compose up -d
```

## CI / GitHub Actions

The workflow at `.github/workflows/ci.yml` runs on every pull request and push to `main`:

1. Runs the test suite against Node.js 20 and 22
2. Builds the Docker image to verify the `Dockerfile` is valid

Merging to `main` requires all checks to pass.

## Project structure

```
csptool-receiver/
├── src/
│   ├── app.js          # Express app factory (routes, middleware)
│   ├── db.js           # SQLite wrapper (createDb)
│   └── public/
│       └── index.html  # Vue 3 dashboard (CDN, no build step)
├── tests/
│   ├── app.test.js
│   ├── db.test.js
│   └── socket.test.js
├── server.js           # Entry point — wires HTTP server + Socket.io
├── Dockerfile
└── .github/workflows/ci.yml
```
