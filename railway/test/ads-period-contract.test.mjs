import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const passport = readFileSync(new URL('../../docs/SITE-PASSPORT.md', import.meta.url), 'utf8');
const agents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8');
const adsServer = readFileSync(new URL('../src/wb-ads.js', import.meta.url), 'utf8');

test('Advertising exposes the standard five period choices without changing other screens', () => {
  assert.match(html, /id="adsPeriod" class="period"/);
  assert.match(html, /data-ads-period="today"[^>]*>Сегодня<\/button>/);
  assert.match(html, /data-ads-period="yesterday"[^>]*>Вчера<\/button>/);
  assert.match(html, /data-ads-period="7"[^>]*>7 дней<\/button>/);
  assert.match(html, /data-ads-period="30"[^>]*>30 дней<\/button>/);
  assert.match(html, /data-ads-period="custom"[^>]*>Свой период<\/button>/);
  assert.match(html, /id="adsDateFrom" type="date"/);
  assert.match(html, /id="adsDateTo" type="date"/);
});

test('Advertising period is persistent analysis state while the daily budget remains today-only', () => {
  assert.match(html, /localStorage\.getItem\('adsSelectedPeriod'\)/);
  assert.match(html, /function adsMetricsForRow\(row\)/);
  assert.match(html, /todaySpend=Number\(row\.todaySpend\)\|\|0/);
  assert.match(html, /data\.day===day\?wbAdsMoneyText\(todaySpend\)/);
});

test('Server fills a 30-day cache in the existing advertising snapshot', () => {
  assert.match(adsServer, /historyFrom = localDate\(Date\.now\(\) - 29 \* 86400000\)/);
  assert.match(adsServer, /beginDate=' \+ historyFrom \+ '&endDate=' \+ historyTo/);
  assert.match(adsServer, /periodMetrics: hasFreshStats/);
});

test('Passport defines the standard but explicitly forbids opportunistic mass alignment', () => {
  assert.match(passport, /«Сегодня», «Вчера», «7 дней», «30 дней», «Свой период»/);
  assert.match(passport, /текущая задача распространяет его только на «Рекламу»/);
  assert.match(passport, /Массовое выравнивание остальных экранов требует отдельного согласования/);
  assert.match(agents, /Единый UI-стандарт — цель для новых и затрагиваемых элементов, а не разрешение/);
});

test('Kaspi has its own advertising tab and selects only the marketing connection endpoint', async () => {
  const markup = html.slice(html.indexOf('<section id="ads"'), html.indexOf('<section id="settings"'));
  assert.match(markup, /data-ads-market="Kaspi"[^>]*>Kaspi<\/button>/);
  const kaspi = markup.slice(markup.indexOf('id="adsKaspiPanel"'), markup.indexOf('id="adsWbPanel"'));
  assert.match(kaspi, /id="kaspiMarketingButton"[^>]*openKaspiMarketing/);
  assert.match(kaspi, /showKaspiAdsHistory/);
  assert.doesNotMatch(kaspi, /Аудит привязки|openAdsLinkAudit/);
  assert.doesNotMatch(markup.slice(0, markup.indexOf('id="adsKaspiPanel"')), /openKaspiMarketing/);

  const requests = [];
  const ctx = vm.createContext({
    adsMarket: 'Kaspi', adsRenderInFlight: false,
    document: { getElementById: () => ({}), activeElement: null },
    startAdsSnapshotWatcher() {}, supportedAdsMarket: market => market,
    syncAdsMarketView() {}, paintKaspiAdsPanel: data => { ctx.result = data; },
    adsApi: async path => { requests.push(path); return { connected: true, shop: 'LUXAR' }; },
  });
  const start = html.indexOf('async function renderAds(){');
  const end = html.indexOf('async function saveAdsLimit(', start);
  vm.runInContext(html.slice(start, end), ctx);
  await ctx.renderAds();
  assert.deepEqual(requests, ['/api/kaspi-marketing/state']);
  assert.equal(ctx.result.shop, 'LUXAR');
});

test('link audit reads only WB1 and WB2', async () => {
  const requests = [];
  const ctx = vm.createContext({
    window: {},
    adsAuditPeriodSpec: () => ({ days: 180 }),
    adsAuditWbUrl: market => market,
    showSheet() {},
    document: { getElementById: () => ({ isConnected: true }) },
    apiJson: async market => { requests.push(market); return { market }; },
    paintAdsLinkAudit() {},
  });
  const start = html.indexOf('async function openAdsLinkAudit(period)');
  const end = html.indexOf('\n}', start) + 2;
  vm.runInContext(html.slice(start, end), ctx);
  await ctx.openAdsLinkAudit();
  assert.deepEqual(requests, ['WB', 'WB2']);
  assert.deepEqual(Object.keys(ctx.window.__adsAuditView), ['wb1', 'wb2']);
});

test('Kaspi advertising report keeps its total and skips the audit action', async () => {
  const source=readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');
  const ctx=vm.createContext({
    window:{}, reportPeriod:7, marketplaceReportContext:null,
    reportAdsPeriodLabel:()=> '7 дней',
    warmKaspi:()=>({ads:120}), reportAdsLooseKaspi:()=>20,
    warmWb:()=>({ads:80,financeAvailable:true}),
    esc:String, fmt:value=>value+' ₸', showSheet:markup=>{ctx.markup=markup},
  });
  vm.runInContext(source.split('\n').find(line=>line.startsWith('window.openReportAdsPanel=')),ctx);
  await ctx.window.openReportAdsPanel('Kaspi');
  assert.match(ctx.markup,/120 ₸/);
  assert.match(ctx.markup,/20 ₸/);
  assert.doesNotMatch(ctx.markup,/Разобрать/);
  await ctx.window.openReportAdsPanel('WB');
  assert.match(ctx.markup,/Разобрать/);
});

test('WB campaign rows keep key metrics and search-query access visible with details collapsed', () => {
  const context = vm.createContext({
    adsDashboardData: { day:'2026-11-20', campaigns:[
      {id:41,name:'Длинное название кампании',status:9,rule:{dailyLimit:2000},metric:{complete:true,spend:250,revenue:1000,orders:3,clicks:15}},
      {id:42,name:'Неполный период',status:11,metric:{complete:false,spend:90,revenue:300,orders:1,clicks:2}},
    ], groups:[{id:'group',name:'Формы',campaignIds:[41]}]},
    adsDashboardFilter:'all', adsDashboardQuery:'', adsMarket:'WB2', adsExpandedCards:new Set(),
    wbAdOpenGroups:new Set(['WB2:group']),
    adsSyncPeriodControls() {}, adsFreshnessHtml:()=>'', adsPeriodRange:()=>({title:'Сегодня'}),
    adsIsoDateOffset:()=> '2026-11-20', adsAdvice:()=>({key:'wait'}), adsAutoStartLabel:()=> '',
    adsMetricsForRow:row=>row.metric, esc:String,
    localStorage:{setItem() {}},
  });
  const nodes=new Map();
  context.document={getElementById(id){
    if (!nodes.has(id)) nodes.set(id,{innerHTML:''});
    return nodes.get(id);
  }};
  const sections = [
    ['function adsStatusLabel(', 'let adsDashboardData='],
    ['function wbAdsMoneyText(', 'function adsErrorText('],
    ['function adsCardKey(', 'function adsOpenSchedule('],
    ['function drawAdsDashboard(){', 'function adsAuditReasonLabel('],
    ['function wbAdGroupMetric(', 'function toggleWbAdGroup('],
  ];
  for(const [from,to] of sections) vm.runInContext(html.slice(html.indexOf(from),html.indexOf(to,html.indexOf(from))),context);
  context.drawAdsDashboard();
  const groups=nodes.get('adsGroups').innerHTML;
  const [head,details]=groups.split('<div id="adsDetails_41" class="ad-card-body">');
  assert.match(head,/adsCard_41[^>]*collapsed/);
  assert.match(head,/aria-expanded="false" aria-controls="adsDetails_41"/);
  for(const label of ['Расход','Клики','Заказы','ДРР']) assert.ok(head.includes('<small>'+label+'</small>'));
  assert.match(head,/aria-label="Запросы · корзины"[^>]*openWbQueryHistory\(41\)/);
  assert.doesNotMatch(head,/Расписание|changeAdsCampaignState/);
  assert.match(details,/Расписание/);
  assert.match(details,/changeAdsCampaignState\(41,'pause'/);
  assert.match(details,/<details><summary>Сравнение кампаний<\/summary>/);
  assert.match(nodes.get('adsList').innerHTML,/<small>Расход<\/small><b>—<\/b>/);

  const button={setAttribute(key,value){this[key]=value;}, 'aria-expanded':'false'}, caret={textContent:'⌄'};
  let collapsed=true;
  nodes.set('adsCard_41',{classList:{toggle(_class, value){collapsed=value;}},querySelector:s=>s==='.ad-card-head'?button:caret});
  context.adsToggleCard(41);
  assert.equal(collapsed,false);
  assert.equal(button['aria-expanded'],'true');
  assert.equal(caret.textContent,'⌃');
});
