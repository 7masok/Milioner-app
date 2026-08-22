# Railway/PostgreSQL migration

The production cutover is deliberately split into reversible stages. Cloudflare D1 remains unchanged until the Railway service, data import, row checks, and cross-device checks all pass.

## Services

- `millioner-api`: this repository, started with `npm start`.
- `Postgres`: Railway PostgreSQL service.
- GitHub Pages: the existing static frontend. Its API URL is changed only during the final cutover.

## Railway variables

Add these in Railway Variables. Use a reference variable for `DATABASE_URL`:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
CORS_ORIGIN=https://7masok.github.io
APP_ADMIN_TOKEN=<random secret>
KASPI_TOKEN=<secret>
WB_TOKEN=<secret>
WB_TOKEN_2=<secret>
WB_WAREHOUSE_ID=<secret/config>
WB_WAREHOUSE_ID_2=<secret/config>
WAREHOUSE_WRITES_ENABLED=false
MARKET_SYNC_ENABLED=false
```

Do not commit `.env`, database URLs, API tokens, feed keys, or marketplace credentials.

## Safe import sequence

1. Keep `WAREHOUSE_WRITES_ENABLED=false` and `MARKET_SYNC_ENABLED=false`.
2. Run migrations: `npm run db:migrate`.
3. Inspect the D1 export without touching PostgreSQL:
   `npm run db:import:d1 -- /secure/path/millioner-db-full.sql`.
4. Import only into an empty target database:
   `npm run db:import:d1 -- /secure/path/millioner-db-full.sql --apply`.
   The importer aborts if any of the 24 target tables already contains rows.
5. Compare every table count and deterministic row checksum:
   `npm run db:verify -- /secure/path/millioner-db-full.sql`.
6. Test all read endpoints while writes remain disabled.
7. Take a final D1 delta/full export immediately before cutover and repeat import/verification in a fresh Postgres service if D1 changed.
8. Enable writes on Railway, point the frontend to the Railway URL, and test phone/computer edits.
9. Keep D1 and the old Worker untouched for rollback.

## Server authority

The browser always loads `warehouse_state` from PostgreSQL. Browser `localStorage` is not read as business data and is never uploaded. A revision conflict reloads the newer server state instead of merging an unknown local snapshot.


