import express from 'express';
import { pool } from './db.js';
import { asyncRoute } from './http.js';

export const wbHourlyOrdersRouter = express.Router();

function hourSeries() {
  return Array.from({ length: 24 }, () => 0);
}

function windowLabel(startHour) {
  const endHour = (startHour + 2) % 24;
  const hh = value => String(value).padStart(2, '0') + ':00';
  return `${hh(startHour)}–${hh(endHour)}`;
}

export function quietestTwoHourWindow(input = []) {
  const hours = hourSeries().map((_, hour) => Math.max(0, Number(input?.[hour] || 0)));
  let best = null;
  for (let startHour = 0; startHour < 24; startHour += 1) {
    const orders = hours[startHour] + hours[(startHour + 1) % 24];
    if (!best || orders < best.orders) {
      best = {
        startHour,
        endHour: (startHour + 2) % 24,
        orders,
        label: windowLabel(startHour)
      };
    }
  }
  return best;
}

export async function readWbHourlyOrders(days = 30) {
  const periodDays = Math.max(1, Math.min(90, Math.trunc(Number(days) || 30)));
  const until = Date.now();
  const since = until - periodDays * 86_400_000;
  const markets = ['WB', 'WB2'];

  const [hourlyResult, coverageResult] = await Promise.all([
    pool.query(`SELECT market,
      EXTRACT(HOUR FROM (to_timestamp(creation_date / 1000.0) AT TIME ZONE 'Asia/Almaty'))::integer AS hour,
      COUNT(DISTINCT order_id)::integer AS orders
      FROM marketplace_order_lines
      WHERE market = ANY($1::text[]) AND creation_date >= $2 AND creation_date < $3
      GROUP BY market,hour ORDER BY market,hour`, [markets, since, until]),
    pool.query(`SELECT market,MIN(creation_date)::bigint AS "coverageFrom",
      MAX(creation_date)::bigint AS "coverageTo",COUNT(DISTINCT order_id)::integer AS orders
      FROM marketplace_order_lines
      WHERE market = ANY($1::text[]) AND creation_date >= $2 AND creation_date < $3
      GROUP BY market ORDER BY market`, [markets, since, until])
  ]);

  const byMarket = { WB: hourSeries(), WB2: hourSeries() };
  for (const row of hourlyResult.rows) {
    const market = String(row.market || '');
    const hour = Number(row.hour);
    if (!byMarket[market] || !Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    byMarket[market][hour] = Math.max(0, Number(row.orders || 0));
  }

  const total = hourSeries().map((_, hour) => byMarket.WB[hour] + byMarket.WB2[hour]);
  const coverage = Object.fromEntries(markets.map(market => [market, { coverageFrom: null, coverageTo: null, orders: 0 }]));
  for (const row of coverageResult.rows) {
    const market = String(row.market || '');
    if (!coverage[market]) continue;
    coverage[market] = {
      coverageFrom: Number(row.coverageFrom || 0) || null,
      coverageTo: Number(row.coverageTo || 0) || null,
      orders: Math.max(0, Number(row.orders || 0))
    };
  }

  return {
    ok: true,
    days: periodDays,
    timezone: 'Asia/Almaty',
    since,
    until,
    byMarket,
    total,
    coverage,
    quietest: {
      WB: quietestTwoHourWindow(byMarket.WB),
      WB2: quietestTwoHourWindow(byMarket.WB2),
      total: quietestTwoHourWindow(total)
    }
  };
}

export async function logWbHourlyOrders(days = 30) {
  try {
    const stats = await readWbHourlyOrders(days);
    console.info('WB_HOURLY_ORDERS', JSON.stringify(stats));
    return stats;
  } catch (error) {
    console.warn('WB_HOURLY_ORDERS', JSON.stringify({ ok: false, error: String(error?.message || error) }));
    return null;
  }
}

wbHourlyOrdersRouter.get('/wb-hourly-orders', asyncRoute(async (req, res) => {
  res.json(await readWbHourlyOrders(req.query.days));
}));
