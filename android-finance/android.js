(()=>{
  const failure='Не удалось передать файл. Повтори скачивание.';
  function call(action,data){
    const result=prompt('finance-file-'+action+':'+JSON.stringify(data));
    // Never expose a parser exception containing exported financial data.
    if(!result||result.length>200)throw Error(failure);
    return result;
  }
  function utf8(text){
    const bytes=new TextEncoder().encode(text);let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(binary);
  }
  async function save(base64,name,mime){
    let id;
    try{
      const token=call('begin',{name,mime,length:base64.length});
      if(!/^[a-f0-9-]{36}$/.test(token))throw Error(token);
      id=token;
      for(let start=0,index=0;start<base64.length;start+=4000,index++){
        const result=call('chunk',{id,index,data:base64.slice(start,start+4000)});
        if(result!=='ok')throw Error(result);
      }
      const result=call('finish',{id});if(result!=='ok')throw Error(result);
    }catch(e){
      if(id){try{call('abort',{id});}catch(ignored){}}
      throw e;
    }
  }
  window.AndroidFinances={
  saveBackup:async(text,name)=>save(utf8(text),name,'application/json'),
  saveStatement:async(text,name,mime)=>save(utf8(text),name,mime),
  saveExcel:async(base64,name)=>save(base64,name,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  consumeShared:async()=>{const raw=prompt('finance-take-pdf:');if(!raw)return false;const data=JSON.parse(raw);if(data.error){alert(data.error);return true;}const bytes=Uint8Array.from(atob(data.base64),c=>c.charCodeAt(0));openView('finance');await financeProcessStatementFile(new File([bytes],data.name,{type:'application/pdf'}),{shared:true});return true;}
};
  financeConsumeSharedStatement=()=>AndroidFinances.consumeShared();
})();
