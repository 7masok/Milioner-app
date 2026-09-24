# Railway application

This is the only active application service for Склад.

## Architecture

```text
Browser → Railway API → Railway PostgreSQL
Railway → Kaspi and Wildberries APIs
```

The browser reads and saves business data through the Railway API. PostgreSQL is
the single source of truth for products, purchases, movements, settings,
reservations, and history.

## Railway variables

Configure these in Railway Variables:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
CORS_ORIGIN=https://milioner-app-staging.up.railway.app
APP_ADMIN_TOKEN=<random secret>
WEBAUTHN_RP_ID=milioner-app-staging.up.railway.app
KASPI_TOKEN=<secret>
WB_TOKEN=<secret>
WB_TOKEN_2=<secret>
WB_WAREHOUSE_ID=<secret/config>
WB_WAREHOUSE_ID_2=<secret/config>
WAREHOUSE_WRITES_ENABLED=true
MARKET_SYNC_ENABLED=true
```

Do not commit `.env`, database URLs, API tokens, feed keys, or marketplace
credentials.

Login uses `APP_ADMIN_TOKEN` as the access code on every device.
WebAuthn credentials may remain in the database for compatibility, but the
normal sign-in flow does not require fingerprints, Windows Hello, USB keys, or
device binding.

## Running

```sh
npm start
```

The startup command applies PostgreSQL migrations and starts the API.
