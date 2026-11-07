import {startBusinessReportLoop} from './business-report-worker.js';
import {pool} from './db.js';

// Keep the scheduler alive independently of the HTTP event loop.
const keepAlive=setInterval(()=>{},60000);
function stop(){
 clearInterval(keepAlive);
 void pool.end().finally(()=>process.exit(0));
 const deadline=setTimeout(()=>process.exit(1),5000);
 deadline.unref();
}
process.once('SIGTERM',stop);
process.once('SIGINT',stop);
process.once('disconnect',stop);
startBusinessReportLoop();
