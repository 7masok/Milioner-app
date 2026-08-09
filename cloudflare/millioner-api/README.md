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
WB FBS API ───┘

The Worker runs every 10 minutes using a Cron Trigger, normalizes marketplace order lines, and upserts them into D1.

Kaspi's dedicated Worker enriches each order with separate entry/product requests. Large pages can exceed the Cloudflare external-subrequest limit, so the central sync deliberately reads the seven-day active Kaspi Delivery feed in small `size=12` pages. Each Worker invocation then stays inside its own subrequest budget. Current packing orders remain `KASPI_DELIVERY`; handed-off Kaspi Delivery orders are normalized to `KASPI_DELIVERY_TRANSIT` for the website. When `KASPI_TOKEN` is configured, the direct API path can use `courierTransmissionDate` as the authoritative handoff marker.

Operational verification should use `/api/market-status` together with `/api/orders?market=Kaspi&limit=1000`, because a successful sync run alone does not prove that a specific new order was persisted.

## Cloudflare setup

1. Create a D1 database named `millioner-db`.
2. Copy its Database ID.
3. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with that ID.
4. Deploy this Worker with root directory `cloudflare/millioner-api`.
5. Add a Secret named `APP_ADMIN_TOKEN` with a long random value. It protects write/import/manual-sync endpoints.
6. Confirm the D1 binding variable is `DB`.
7. Add `WB_TOKEN` as a Worker Secret for `millioner-api` to enable current Wildberries FBS order synchronization. The backend uses the WB Marketplace API (`/api/v3/orders` and `/api/v3/orders/status`), not the Statistics API.
8. `KASPI_TOKEN` is optional while the dedicated Kaspi Worker is available; adding it enables direct recovery and authoritative courier handoff metadata.

The Worker creates its tables automatically on first request. `schema.sql` is also included as the canonical schema for inspection/manual migration.

## Endpoints

- `GET /health` — verifies Worker and D1 binding.
- `GET /api/orders?market=Kaspi|WB|Ozon` — returns normalized shared orders.
- `GET /api/products` — returns shared products and marketplace links.
- `GET /api/sync-status` — latest background sync result per marketplace.
- `GET /api/market-status` — integration status, last success, line counts, and next scheduled sync.
- `POST /admin/sync?market=Kaspi|WB` — manual server-side sync; requires `Authorization: Bearer <APP_ADMIN_TOKEN>`.
- `POST /admin/import-products` — imports current product cards into D1; requires the same authorization header.

## Secrets

Do not put `APP_ADMIN_TOKEN`, `KASPI_TOKEN`, `WB_TOKEN`, or future Ozon credentials into `index.html` or commit them to GitHub. Configure them as Cloudflare Worker Secrets.
