import {pool, transaction, withDatabaseReadClient} from './db.js';
import {config} from './config.js';
import {loadBusinessReportState} from './business-report-worker.js';
import {createBusinessReportRuntime} from './business-report-runtime.js';
import {readBusinessReportApi} from './business-report-reader.js';
import {kaspiMarketingService} from './kaspi-marketing.js';
import {kaspiFeedRows, kaspiStockFeedStatus} from './stock.js';
import {listKaspiPrices} from './prices.js';
import {persistWarehouseProducts} from './warehouse-products.js';

const DAY = 86400000;
const OFFSET = 18000000;
const iso = timestamp => new Date(timestamp + OFFSET).toISOString().slice(0, 10);
const midnight = timestamp => Math.floor((timestamp + OFFSET) / DAY) * DAY - OFFSET;
const confirmed = (days, start, end) => {
  for (let day = start; day < end; day += DAY) if (!days.has(iso(day))) return false;
  return true;
};
const endOfTest = test => (test.weekly ? Math.ceil((test.startedAt + OFFSET) / DAY) * DAY - OFFSET : test.startedAt) + test.days * DAY;
const readPayload = row => typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;

async function warehouseEdit(edit) {
  return transaction(async client => {
    const doc = (await client.query('SELECT payload FROM warehouse_state WHERE id=1 FOR UPDATE')).rows[0];
    if (!doc) return false;
    const payload = readPayload(doc), settings = payload.settings ||= {};
    if (!await edit(settings, client)) return false;
    await client.query('UPDATE warehouse_state SET payload=$1,revision=revision+1,updated_at=$2 WHERE id=1',
      [JSON.stringify(payload), Date.now()]);
    return true;
  });
}

async function setTestPrice(client, productId, previous, price, expectedCost) {
  const row = (await client.query('SELECT payload FROM warehouse_products WHERE id=$1 FOR UPDATE',[productId])).rows[0];
  if (!row) return false;
  const item = readPayload(row);
  if (expectedCost !== undefined && Number(item.cost) !== expectedCost) return false;
  const currentPrice = Number(item.kaspiPrice) || ((await listKaspiPrices(client)).rows.find(row => row.productId === productId)?.price);
  if (currentPrice !== previous) return false;
  if (currentPrice === price) return true;
  await persistWarehouseProducts(client,[{...item, kaspiPrice:price}]);
  return true;
}

async function calculate(now, params) {
  return transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='25s'");
    return withDatabaseReadClient(client, async () => {
      const state = await loadBusinessReportState(client);
      const runtime = createBusinessReportRuntime({state,market:'Kaspi',readApi:readBusinessReportApi,now});
      return runtime.kaspiAdvertising(params);
    });
  });
}

async function finishTests(settings, connection, now) {
  for (const test of Object.values(settings.kaspiPriceTests || {})) {
    if (!test.automatic || test.stoppedAt || test.decision || now < endOfTest(test)) continue;
    const end = endOfTest(test);
    const from = iso(end - 14 * DAY), to = iso(end - DAY);
    const downloaded = (await kaspiStockFeedStatus()).lastFetchedAt >= test.startedAt;
    const outcome = downloaded && connection.accountId === test.accountId
      && confirmed(new Set(connection.confirmedDays), end-14*DAY, end)
      ? await calculate(now,{from,to,...connection,test}) : null;
    if (!outcome && test.restoredAt && now < end + 7 * DAY) continue;
    await warehouseEdit(async (latest,client) => {
      const current = latest.kaspiPriceTests?.[test.productId];
      if (!current || current.startedAt !== test.startedAt || current.decision || current.stoppedAt) return false;
      const previous = current.restoredAt ? test.before : test.after;
      const winner = outcome?.after > outcome?.before ? test.after : test.before;
      const applied = await setTestPrice(client,test.productId,previous,winner);
      if (outcome || !applied || now >= end + 7 * DAY) {
        current.decision = {at:now, winner, applied, inconclusive:!outcome, ...outcome};
      } else {
        current.restoredAt = now;
      }
      return true;
    });
  }
}

export function chooseWeeklyPrice(rows) {
  return rows.filter(({metrics:m,price,stock}) => stock > 0 && m.bid >= 3 && m.views >= (m.bid === 3 ? 100 : 500)
    && m.clicks >= 30 && Number.isFinite(m.orders) && m.orders / m.clicks < .02
    && !m.totalPreliminary && m.testPriceFloor > 0 && m.testPriceFloor < price)
    .sort((a,b) => Number(b.metrics.bid === 3) - Number(a.metrics.bid === 3) || b.metrics.views - a.metrics.views
      || a.productId.localeCompare(b.productId))[0];
}

export async function runKaspiWeekly(client, now = Date.now()) {
  const connection = await kaspiMarketingService.state();
  if (!connection.connected || connection.reconnect) return;
  const settings = readPayload((await client.query('SELECT payload FROM warehouse_state WHERE id=1')).rows[0] || {payload:{}}).settings || {};
  await finishTests(settings, connection, now);
  const week = midnight(now);
  if (new Date(week + OFFSET).getUTCDay() !== 1 || settings.kaspiWeeklyRun?.week === week && settings.kaspiWeeklyRun.completed) return;
  if (!confirmed(new Set(connection.confirmedDays),week-7*DAY,week)) return;

  const from = iso(week-7*DAY), to = iso(week-DAY);
  const [report, feed, feedStatus, priceList] = await Promise.all([
    calculate(now,{from,to,...connection}),kaspiFeedRows(),kaspiStockFeedStatus(),listKaspiPrices()
  ]);
  const rowsByProduct = new Map(), campaignsByProduct = new Map();
  const productsOnFeed = new Map(feed.map(row => [row.productId,row]));
  const prices = new Map(priceList.rows.map(row => [row.productId,row.price]));
  const currentTests = settings.kaspiPriceTests || {};
  const complete = !report.incomplete;
  if (report.incomplete && now < week + 18 * 3600000 && settings.kaspiWeeklyRun?.week !== week) return;
  for (const campaign of report.campaigns) {
    const [accountId,campaignId] = campaign.key.split(':');
    if (accountId !== connection.accountId || !/^\d+$/.test(campaignId)) continue;
    for (const row of campaign.products.values()) if (row.productId) {
      campaignsByProduct.set(row.productId,(campaignsByProduct.get(row.productId)||0)+1);
    }
    const current = await kaspiMarketingService.products({accountId,campaignId,from,to});
    const bySku = new Map(current.products.map(row => [row.sku,row]));
    for (const row of campaign.products.values()) {
      const test = currentTests[row.productId], stats = bySku.get(row.sku);
      if (!row.productId || !stats || !Number.isFinite(stats.bid) || test && !test.stoppedAt && !test.decision && (test.automatic || now < endOfTest(test))) continue;
      const feedRow = productsOnFeed.get(row.productId);
      const entry = {...feedRow,price:prices.get(row.productId),productId:row.productId,accountId,campaignId,sku:row.sku,metrics:report.metrics(row,campaign,stats)};
      const group = rowsByProduct.get(row.productId) || [];
      group.push(entry);rowsByProduct.set(row.productId,group);
    }
  }
  const entries = [...rowsByProduct.values()].flat();
  let run = settings.kaspiWeeklyRun;
  if (run?.week !== week) {
    const hasTest = settings.kaspiWeeklyPriceDraft || Object.values(currentTests).some(test =>
      !test.stoppedAt && !test.decision && (test.automatic || now < endOfTest(test)));
    const price = complete && !hasTest && feedStatus.ready && feedStatus.lastFetchedAt >= now - DAY
      ? chooseWeeklyPrice(entries.filter(row => campaignsByProduct.get(row.productId) === 1 &&
        !feedStatus.missingOffers.some(offer => String(offer.productId) === row.productId))) : undefined;
    run = {week, completed:false, bids:entries.filter(row => row.productId !== price?.productId && row.stock > 0
      && row.metrics.bidProposal?.bid >= 3 && row.metrics.bidProposal.bid !== row.metrics.bid
      && (row.metrics.bidProposal.bid < row.metrics.bid || complete)).map(row => ({
        accountId:row.accountId,campaignId:row.campaignId,sku:row.sku,before:row.metrics.bid,bid:row.metrics.bidProposal.bid
      }))};
    await warehouseEdit(async (latest,db) => {
      if (price && !latest.kaspiWeeklyPriceDraft && !Object.values(latest.kaspiPriceTests || {}).some(test =>
        !test.stoppedAt && !test.decision && (test.automatic || now < endOfTest(test)))) {
        const after = price.metrics.testPriceFloor;
        if (await setTestPrice(db,price.productId,price.price,after,price.metrics.cost)) {
          (latest.kaspiPriceTests ||= {})[price.productId] = {productId:price.productId,name:price.name,
            before:price.price,after,days:7,startedAt:now,weekly:true,automatic:true,accountId:connection.accountId};
        }
      }
      latest.kaspiWeeklyRun = run;
      return true;
    });
  }
  const live = new Map(entries.map(row => [JSON.stringify([row.accountId,row.campaignId,row.sku]),row.metrics.bid]));
  for (const bid of run.bids) {
    if (live.get(JSON.stringify([bid.accountId,bid.campaignId,bid.sku])) !== bid.before) continue;
    await kaspiMarketingService.setBid({...bid,weekStart:week});
  }
  await warehouseEdit(latest => {
    if (latest.kaspiWeeklyRun?.week !== week) return false;
    latest.kaspiWeeklyRun = {week,completed:true};
    return true;
  });
}

export function startKaspiWeeklyLoop() {
  if (!config.writesEnabled || config.storeProfile === 'WB3') return;
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    let client, locked;
    try {
      client = await pool.connect();
      locked = (await client.query('SELECT pg_try_advisory_lock(730150,6) AS locked')).rows[0]?.locked;
      if (locked) await runKaspiWeekly(client);
    } catch (error) {
      console.warn('Kaspi weekly automation:', String(error.message).slice(0,180));
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(730150,6)').catch(()=>{});
      client?.release();
      running = false;
    }
  },60000).unref();
}
