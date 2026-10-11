// Fill the bundled Excel template locally. ZIP entries are stored (no compression,
// no third-party runtime or network); every cell has an explicit safe value type.
(function () {
  'use strict';
  const encoder = new TextEncoder();
  const xml = value => String(value ?? '').replace(/_x[0-9a-fA-F]{4}_/g, s => '_x005F_' + s.slice(1)).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, c => '_x' + c.charCodeAt(0).toString(16).padStart(4, '0') + '_').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const col = i => { let name = ''; for (i++; i; i = Math.floor((i - 1) / 26)) name = String.fromCharCode(65 + (i - 1) % 26) + name; return name; };
  const crcTable = Array.from({length:256}, (_, n) => { for (let i=0;i<8;i++) n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0; });
  function crc(bytes) { let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0; }
  function zip(files) {
    const chunks=[],directory=[];let offset=0;
    for(const [path,text] of Object.entries(files)){
      const name=encoder.encode(path),bytes=encoder.encode(text),checksum=crc(bytes);
      const local=new Uint8Array(30+name.length),v=new DataView(local.buffer);
      v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(12,33,true);
      v.setUint32(14,checksum,true);v.setUint32(18,bytes.length,true);v.setUint32(22,bytes.length,true);v.setUint16(26,name.length,true);local.set(name,30);
      const central=new Uint8Array(46+name.length),c=new DataView(central.buffer);
      c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(14,33,true);
      c.setUint32(16,checksum,true);c.setUint32(20,bytes.length,true);c.setUint32(24,bytes.length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);central.set(name,46);
      chunks.push(local,bytes);directory.push(central);offset+=local.length+bytes.length;
    }
    const dirSize=directory.reduce((n,x)=>n+x.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);
    e.setUint32(0,0x06054b50,true);e.setUint16(8,directory.length,true);e.setUint16(10,directory.length,true);e.setUint32(12,dirSize,true);e.setUint32(16,offset,true);
    const result=new Uint8Array(offset+dirSize+22);let at=0;for(const chunk of [...chunks,...directory,end]){result.set(chunk,at);at+=chunk.length;}return result;
  }
  function cell(reference,value,style,formula=null,cache=0){
    if(formula)return '<c r="'+reference+'" s="'+style+'"><f>'+xml(formula)+'</f><v>'+cache+'</v></c>';
    if(value==null||value==='')return '<c r="'+reference+'" s="'+style+'"/>';
    if(typeof value==='number'){
      if(!Number.isFinite(value))throw Error('В выписке есть неверная сумма.');
      return '<c r="'+reference+'" s="'+style+'"><v>'+value+'</v></c>';
    }
    if(String(value).length>32767)throw Error('Название или комментарий слишком длинный для Excel.');
    return '<c r="'+reference+'" s="'+style+'" t="inlineStr"><is><t xml:space="preserve">'+xml(value)+'</t></is></c>';
  }
  function dateSerial(s){
    const m=String(s).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return m?(Date.UTC(+m[3],+m[2]-1,+m[1])-Date.UTC(1899,11,30))/86400000:null;
  }
  window.FinanceExcel={
    build({period,selection,count,columns,rows,totals}){
      const template=window.FinanceExcelTemplate,s=template.styles,header=7+Math.max(1,totals.length),first=header+1,last=header+rows.length,lastCol=col(columns.length-1);
      if(last>1048576)throw Error('Слишком много строк для Excel.');
      const data=[];
      const row=(r,cells,height=24)=>'<row r="'+r+'" ht="'+height+'" customHeight="1">'+cells.join('')+'</row>';
      data.push(row(2,[cell('A2','Выписка',s.title)],30),row(3,[cell('A3',period,s.text)]),row(4,[cell('A4',selection,s.text)]),row(5,[cell('A5','Операций: '+count,s.text),cell('F5','Поступления',s.totalLabel),cell('G5','Списания',s.totalLabel)]));
      totals.forEach((t,i)=>{
        const r=6+i,currency=t.currency;
        const formula=letter=>'SUMIFS('+letter+first+':'+letter+last+',H'+first+':H'+last+',H'+r+')';
        data.push(row(r,[cell('A'+r,'Итого '+currency,s.totalLabel),cell('F'+r,null,s.totalNumber,formula('F'),t.incoming),cell('G'+r,null,s.totalNumber,formula('G'),t.outgoing),cell('H'+r,currency,s.text)]));
      });
      data.push(row(header,columns.map((c,i)=>cell(col(i)+header,c.title,s.header)),34));
      rows.forEach((values,index)=>{
        const r=first+index,alt=index%2===1;
        const cells=values.map((v,i)=>{
          let style=alt?s.textAlt:s.text;
          if(i===0){v=dateSerial(v);style=alt?s.dateAlt:s.date;}
          else if(i===5)style=alt?s.incomingAlt:s.incoming;
          else if(i===6)style=alt?s.outgoingAlt:s.outgoing;
          else if(columns[i].wrap)style=alt?s.wrapAlt:s.wrap;
          return cell(col(i)+r,v,style);
        });
        const lines=Math.max(1,...values.map((v,i)=>columns[i].wrap?String(v||'').split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length/(columns[i].width-2))),0):1));
        data.push(row(r,cells,Math.max(30,Math.min(409,lines*15+8))));
      });
      const cols=columns.map((c,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+c.width+'" customWidth="1"/>').join('');
      const sheet='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:'+lastCol+last+'"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="'+header+'" topLeftCell="A'+first+'" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A'+first+'" sqref="A'+first+'"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="24"/><cols>'+cols+'</cols><sheetData>'+data.join('')+'</sheetData><autoFilter ref="A'+header+':'+lastCol+last+'"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/></worksheet>';
      return zip({...template.parts,'xl/worksheets/sheet1.xml':sheet});
    },
    base64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
  };
})();
