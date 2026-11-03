// Internal calls deliberately bypass HTTP, auth tokens and external transports.
// The allowlist contains only existing PostgreSQL-backed reporting GET handlers.
const ALLOWED=new Set(['/orders','/kaspi-report-orders','/wb-finance-products','/wb-finance-summary','/wb-dashboard-buyouts','/wb-realized-status','/wb-sales-live','/ozon-fbo']);
export async function readBusinessReportApi(path){
 const url=new URL(path,'https://report.internal'),routePath=url.pathname.replace(/^\/api/,'');
 if(!ALLOWED.has(routePath))throw Error('Unsupported report source: '+routePath);
 const router=routePath==='/orders'?(await import('./orders.js')).ordersRouter:routePath==='/ozon-fbo'?(await import('./ozon-fbo.js')).ozonRouter:(await import('./reports.js')).reportsRouter;
 const route=router.stack.find(r=>r.route?.path===routePath&&r.route.methods.get)?.route;
 if(!route)throw Error('Report source unavailable: '+routePath);
 let result,status=200;
 const response={status(n){status=n;return this},set(){return this},setHeader(){return this},json(value){result=value;return this}};
 await route.stack.at(-1).handle({query:Object.fromEntries(url.searchParams),headers:{}},response,error=>{throw error});
 if(status>=400||!result||result.ok===false)throw Error('Report source failed: '+routePath+' HTTP '+status);
 return result;
}
