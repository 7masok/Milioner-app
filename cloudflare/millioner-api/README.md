# Millioner API (Cloudflare Worker + D1)

This directory is the server-side data layer for the Millioner app.

## Purpose

- Keep one shared database for phone and desktop.
- Run marketplace synchronization even when the browser is closed.
- Keep marketplace API tokens outside `index.html`.
- Store normalized Kaspi/WB orders in Cloudflare D1.

## Architecture

Kaspi Worker ─┐
              ├─> `millioner-api` Cron Worker ─> D1 `millioner-db` ─> website
WB Worker ────┘

The Worker runs every 10 minutes using a Cron Trigger. It calls the existing Kaspi and WB Workers, normalizes their order lines and upserts them into D1.

Kaspi polling intentionally uses a recent one-day window. The dedicated Kaspi Worker enriches order lines with separate API requests and can hit the Cloudflare Free external-subrequest limit when a large 14-day history is expanded in one invocation. Older rows remain cached in D1; the short window prioritizes new and currently actionable orders.

Operational verification should use `/api/sync-status` together with `/api/orders?market=Kaspi&limit=1000`, because a successful sync run alone does not prove that a specific new order was persisted.

## Cloudflare setup

1. Create a D1 database named `millioner-db`.
2. Copy its Database ID.
3. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with that ID.
4. Deploy this Worker with root directory `cloudflare/millioner-api`.
5. Add a Secret named `APP_ADMIN_TOKEN` with a long random value. It protects write/import/manual-sync endpoints.
6. Confirm the D1 binding variable is `DB`.

The Worker creates its tables automatically on first request. `schema.sql` is also included as the canonical schema for inspection/manual migration.

## Endpoints

- `GET /health` — verifies Worker and D1 binding.
- `GET /api/orders?market=Kaspi|WB|Ozon` — returns normalized shared orders.
- `GET /api/products` — returns shared products and marketplace links.
- `GET /api/sync-status` — latest background sync result per marketplace.
- `POST /admin/sync?market=Kaspi|WB` — manual server-side sync; requires `Authorization: Bearer <APP_ADMIN_TOKEN>`.
- `POST /admin/import-products` — imports current product cards into D1; requires the same authorization header.

## Secrets

Do not put `APP_ADMIN_TOKEN`, `KASPI_TOKEN`, `WB_TOKEN`, or future Ozon credentials into `index.html` or commit them to GitHub.

Kaspi and WB marketplace tokens remain inside their dedicated marketplace Workers. This central Worker only talks to those Workers.
