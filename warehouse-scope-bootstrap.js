(function () {
  'use strict';
  const config = window.WAREHOUSE_SCOPE_CONFIG || {};
  const embedded = Boolean(config.inferno && location.pathname.startsWith('/inferno/'));
  const rawLocal = window.localStorage, rawSession = window.sessionStorage;
  const prefix = 'inferno:', sessionKey = 'sklad_mvp_v2_owner_session';
  const views = new Set(['home', 'products', 'prices', 'movement', 'purchases', 'reports', 'ads', 'settings']);
  const requestedView = new URLSearchParams(location.search).get('view');
  // Every key (including report/price caches and edit queues) is scoped, not
  // only the warehouse snapshot. The existing main namespace is untouched.
  function scopedStorage(storage) {
    const keys = () => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(k => k.startsWith(prefix));
    const methods = {
      getItem: k => storage.getItem(prefix + k),
      setItem: (k, v) => storage.setItem(prefix + k, v),
      removeItem: k => storage.removeItem(prefix + k),
      clear: () => keys().forEach(k => storage.removeItem(k)),
      key: i => keys()[i]?.slice(prefix.length) ?? null
    };
    return new Proxy(methods, {
      get: (o, k) => k === 'length' ? keys().length : k in o ? o[k] : storage.getItem(prefix + String(k)),
      set: (_, k, v) => { storage.setItem(prefix + String(k), v); return true; },
      deleteProperty: (_, k) => { storage.removeItem(prefix + String(k)); return true; },
      ownKeys: () => keys().map(k => k.slice(prefix.length)),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
    });
  }
  if (embedded) {
    Object.defineProperty(window, 'localStorage', { value: scopedStorage(rawLocal) });
    Object.defineProperty(window, 'sessionStorage', { value: scopedStorage(rawSession) });
    if (window.indexedDB) {
      const factory = window.indexedDB;
      Object.defineProperty(window, 'indexedDB', { value: new Proxy(factory, { get(target, key) {
        if (key === 'open' || key === 'deleteDatabase') return (name, ...args) => target[key](prefix + name, ...args);
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } }) });
    }
    window.MILLIONER_API_URL = location.origin + '/inferno';
  }
  window.WB3_ONLY = Boolean(config.inferno);
  window.warehouseScope = {
    ...config, embedded, requestedView: views.has(requestedView) ? requestedView : '',
    async session() {
      if (!embedded) return null;
      const token = rawLocal.getItem(sessionKey) || rawSession.getItem(sessionKey);
      const back = '/?warehouse=inferno' + (views.has(requestedView) ? '&view=' + requestedView : '');
      if (!token) { location.replace(back); return false; }
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch('/api/inferno/session', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: controller.signal });
        if (response.status === 401 || response.status === 403) { location.replace(back); return false; }
        const data = await response.json();
        if (!response.ok || !data.token) throw new Error('Не удалось подключить Инферно. Обновите страницу.');
        window.localStorage.setItem(sessionKey, data.token); window.sessionStorage.setItem(sessionKey, data.token);
        return data;
      } finally { clearTimeout(timer); }
    },
    afterAuth() {
      const query = new URLSearchParams(location.search);
      if (!config.inferno && config.enabled && query.get('warehouse') === 'inferno') {
        location.replace('/inferno/' + (views.has(requestedView) ? '?view=' + requestedView : '')); return false;
      }
      if (views.has(requestedView)) {
        window.localStorage.setItem('sklad_mvp_v2_active_view_device', requestedView);
        query.delete('view'); query.delete('warehouse');
        window.history?.replaceState(null, '', location.pathname + (query.size ? '?' + query : '') + (location.hash || ''));
      }
      return true;
    },
    logout() {
      if (!embedded) return;
      rawLocal.removeItem(sessionKey); rawSession.removeItem(sessionKey);
      window.localStorage.removeItem(sessionKey); window.sessionStorage.removeItem(sessionKey);
      location.replace('/');
    }
  };
})();
