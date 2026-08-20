// Deprecated: recovery is performed server-side from the verified D1 backup.
// This legacy browser script must never mutate the warehouse document.
(function(){
  'use strict';
  window.restorePurchasesFromCloudflare = async () => ({ ok: false, disabled: true, reason: 'server-side-recovery-only' });
})();
