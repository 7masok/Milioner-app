// Load the warehouse save guard first, then preserved Kaspi helpers.
(function(){
  const saveGuard=document.createElement('script');
  saveGuard.src='./save-conflict-v1.js?v=20260902-large-warehouse';
  saveGuard.async=false;
  document.head.appendChild(saveGuard);

  const purchaseDelete=document.createElement('script');
  purchaseDelete.src='./purchase-delete-v1.js?v=20260821-0014';
  purchaseDelete.async=false;
  document.head.appendChild(purchaseDelete);

  const purchasePlanIgnore=document.createElement('script');
  purchasePlanIgnore.src='./purchase-plan-ignore-v1.js?v=20260901-purchase-speed';
  purchasePlanIgnore.async=false;
  document.head.appendChild(purchasePlanIgnore);

  const kaspiStatusCompat=document.createElement('script');
  kaspiStatusCompat.src='./kaspi-status-compat-v1.js?v=20260821-1635';
  kaspiStatusCompat.async=false;
  document.head.appendChild(kaspiStatusCompat);

  const ads=document.createElement('script');
  ads.src='./kaspi-ads-v2-original.js?v=20260820-low-stock-alerts';
  ads.async=false;
  document.head.appendChild(ads);

  const reservationCompat=document.createElement('script');
  reservationCompat.src='./reservation-compat-v1.js?v=20260820-2324';
  reservationCompat.async=false;
  document.head.appendChild(reservationCompat);

  const extra=document.createElement('script');
  extra.src='./stock-alerts-rescue-v1.js?v=20260901-warehouse-only';
  extra.async=false;
  document.head.appendChild(extra);})();

// Compact advertising cards without changing the campaign controls themselves.
(function compactAdvertisingView(){
  const style=document.createElement('style');
  style.id='adsCompactStyle';
  style.textContent=`
    #ads h2{margin:6px 2px 4px;font-size:18px}
    #ads .link-note{margin:3px 0 5px;padding:6px 8px;font-size:9px;line-height:1.2}
    #ads .market-tabs{margin:3px 0;gap:4px}
    #ads .market-tab{min-width:0;padding:6px 10px;font-size:10px}
    #adsDrrSort{margin-top:3px!important;padding:6px 8px!important;font-size:10px}
    #adsSummary{margin-top:5px!important;padding:7px 8px!important}
    #adsSummary>.two{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:3px!important}
    #adsSummary .muted{font-size:8px;line-height:1.05;white-space:nowrap}
    #adsSummary b{font-size:12px;line-height:1.1}
    #adsList{gap:5px!important;margin-top:5px!important}
    #adsList>.ads-compact-card{margin:0!important;padding:7px 8px!important;border-radius:10px!important}
    .ads-compact-card>.order-head{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;gap:5px!important;align-items:center!important}
    .ads-compact-card>.order-head>div:first-child{min-width:0}
    .ads-compact-card>.order-head b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:1.15}
    .ads-compact-card>.order-head .muted{display:inline;font-size:8px;line-height:1}
    .ads-compact-card>.order-head .badge{padding:3px 6px;font-size:8px;white-space:nowrap}
    .ads-compact-card>.ads-compact-products{margin-top:2px!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px;line-height:1.1}
    .ads-compact-card>.ads-compact-metrics{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:3px!important;margin-top:4px!important}
    .ads-compact-metrics>div{min-width:0;padding:3px 4px!important;border-radius:7px!important}
    .ads-compact-metrics .muted{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:7px;line-height:1}
    .ads-compact-metrics b{font-size:11px;line-height:1.05;white-space:nowrap}
    .ads-compact-card>.ads-compact-traffic{margin-top:3px!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px;line-height:1.1}
    .ads-compact-card>.ads-compact-settings{display:grid!important;grid-template-columns:minmax(66px,1.05fr) minmax(48px,.65fr) minmax(74px,1fr) minmax(48px,.65fr)!important;gap:4px!important;margin-top:4px!important;align-items:end}
    .ads-compact-settings .field{min-width:0;margin:0!important}
    .ads-compact-settings .field>label:first-child{display:none!important}
    .ads-compact-settings input[type=number],.ads-compact-settings input[type=time]{height:28px!important;min-height:28px!important;padding:3px 5px!important;font-size:10px!important}
    .ads-compact-settings .field>label.row{height:28px!important;min-height:28px!important;padding:3px 5px!important;justify-content:center!important}
    .ads-compact-settings .field>label.row>span{display:none!important}
    .ads-compact-settings input[type=checkbox]{width:16px!important;height:16px!important;margin:0!important}
    .ads-compact-actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-top:4px}
    .ads-compact-actions>.btn{width:100%!important;margin:0!important;padding:6px 4px!important;font-size:9px!important;line-height:1.05;white-space:nowrap}
    .ads-compact-actions>.row{display:contents!important}
    .ads-compact-card>.ads-compact-message{margin-top:3px!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:7px!important;line-height:1.05}
    @media(max-width:410px){
      .ads-compact-card>.ads-compact-settings{grid-template-columns:minmax(58px,1fr) 42px minmax(66px,1fr) 42px!important}
      .ads-compact-actions>.btn{font-size:8px!important;padding-left:2px!important;padding-right:2px!important}
    }
  `;
  document.head.appendChild(style);

  function renameLabel(field,shortText){
    const label=field&&field.querySelector(':scope > label:first-child');
    if(!label)return;
    if(!label.title)label.title=label.textContent.trim();
    label.textContent=shortText;
  }

  function compactAdsCards(){
    const list=document.getElementById('adsList');
    if(!list)return;
    [...list.children].forEach(card=>{
      if(!card.classList.contains('item'))return;
      card.classList.add('ads-compact-card');
      const direct=[...card.children];
      const grids=direct.filter(el=>el.classList.contains('two'));
      const metrics=grids[0];
      const settings=grids[1];
      if(metrics){
        metrics.classList.add('ads-compact-metrics');
        const metricLabels=['Расход','Заказы','Выручка','ДРР'];
        [...metrics.children].forEach((cell,index)=>{
          const label=cell.querySelector('.muted');
          if(label&&metricLabels[index]){
            if(!label.title)label.title=label.textContent.trim();
            label.textContent=metricLabels[index];
          }
        });
      }
      if(settings){
        settings.classList.add('ads-compact-settings');
        const fields=[...settings.children];
        renameLabel(fields[0],'Лимит, ₸');
        renameLabel(fields[1],'Стоп');
        renameLabel(fields[2],'Запуск');
        renameLabel(fields[3],'Авто');
        const controlTitles=['Лимит расходов в день, ₸','Остановить по лимиту','Время ежедневного запуска','Запускать по расписанию'];
        fields.forEach((field,index)=>{
          const control=field.querySelector('input');
          if(control&&!control.title)control.title=controlTitles[index]||'';
        });
      }
      const header=direct.find(el=>el.classList.contains('order-head'));
      const products=header&&header.nextElementSibling;
      if(products&&products.classList.contains('muted'))products.classList.add('ads-compact-products');
      const traffic=metrics&&metrics.nextElementSibling;
      if(traffic&&traffic.classList.contains('muted'))traffic.classList.add('ads-compact-traffic');

      let actions=card.querySelector(':scope > .ads-compact-actions');
      if(!actions){
        const save=[...card.children].find(el=>el.matches('button.btn.full'));
        const actionRow=[...card.children].find(el=>el.classList.contains('row'));
        if(save||actionRow){
          actions=document.createElement('div');
          actions.className='ads-compact-actions';
          if(save)actions.appendChild(save);
          if(actionRow)actions.appendChild(actionRow);
          const anchor=settings||traffic||metrics||products||header;
          if(anchor)anchor.insertAdjacentElement('afterend',actions); else card.appendChild(actions);
        }
      }
      [...card.children].forEach(el=>{
        if(el===header||el===products||el===metrics||el===traffic||el===settings||el===actions)return;
        el.classList.add('ads-compact-message');
        const full=el.textContent.trim();
        if(full&&!el.title)el.title=full;
      });
    });
  }

  const originalRenderAds=window.renderAds;
  if(typeof originalRenderAds==='function'){
    window.renderAds=async function(){
      const result=await originalRenderAds.apply(this,arguments);
      compactAdsCards();
      setTimeout(compactAdsCards,0);
      return result;
    };
  }
  compactAdsCards();
})();
