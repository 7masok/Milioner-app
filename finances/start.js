if('serviceWorker' in navigator)navigator.serviceWorker.register('/finances/sw.js',{scope:'/finances/'}).catch(error=>console.warn('finance share target unavailable',error));
initFinanceAuth();
