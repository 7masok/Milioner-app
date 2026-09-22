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

Login is WebAuthn (fingerprint / Face ID / Windows Hello) on the device.
`APP_ADMIN_TOKEN` is only the recovery code used to bind a new device. After
the first passkey is saved, the 4-digit PIN login is disabled.

## Running

```sh
npm start
```

The startup command applies PostgreSQL migrations and starts the API.
