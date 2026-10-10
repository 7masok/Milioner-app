window.AndroidFinances={
  saveBackup:async(text,name)=>{const result=prompt('finance-save:'+JSON.stringify({text,name}));if(result!=='ok')throw Error(result||'Не удалось открыть сохранение файла.');},
  consumeShared:async()=>{const raw=prompt('finance-take-pdf:');if(!raw)return false;const data=JSON.parse(raw);if(data.error){alert(data.error);return true;}const bytes=Uint8Array.from(atob(data.base64),c=>c.charCodeAt(0));openView('finance');await financeProcessStatementFile(new File([bytes],data.name,{type:'application/pdf'}),{shared:true});return true;}
};
financeConsumeSharedStatement=()=>AndroidFinances.consumeShared();
