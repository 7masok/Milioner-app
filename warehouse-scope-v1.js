(function () {
  'use strict';
  const scope = window.warehouseScope || {};
  const bar = document.getElementById('warehouseScopeSwitch');
  if (bar) {
    bar.hidden = !scope.enabled;
    for (const button of bar.querySelectorAll('button')) {
      const active = (button.dataset.scope === 'inferno') === Boolean(scope.inferno);
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    }
  }
  if (scope.inferno) {
    document.querySelector('header .title').textContent = 'Инферно';
    document.querySelector('#loginGate h1').textContent = 'Инферно';
  }
  window.switchWarehouseScope = async function (target) {
    if ((target === 'inferno') === Boolean(scope.inferno)) return;
    if (document.getElementById('modal')?.classList.contains('open')) { alert('Сначала сохраните или закройте открытое окно.'); return; }
    if (typeof warehouseSaveInFlight !== 'undefined' && warehouseSaveInFlight) { alert('Изменения сохраняются. Переключение будет доступно после сохранения.'); return; }
    try {
      if (typeof warehouseLocalDirty !== 'undefined' && warehouseLocalDirty) {
        const saved = await pushWarehouseToServer();
        if (!saved || warehouseLocalDirty) { alert('Сначала нужно сохранить изменения текущего склада.'); return; }
      }
    } catch { alert('Не удалось сохранить изменения. Переключение пока недоступно.'); return; }
    const view = document.querySelector('nav button.active')?.dataset.view || 'home';
    const base = target === 'inferno' ? '/inferno/' : (scope.embedded ? '/' : 'https://milioner-app-staging.up.railway.app/');
    location.assign(base + '?view=' + encodeURIComponent(view));
  };
})();
