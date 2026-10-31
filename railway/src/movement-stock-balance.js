// Immutable observation at posting time, not a reconstruction from today's stock.
export function captureMovementBalance(movement,after,scope='sale'){
 const value=Number(after),qty=Number(movement?.qty),before=value-qty;
 if(after===null||after===undefined||![value,qty,before].every(Number.isSafeInteger)||value<0||before<0)return movement;
 movement.stockBalance={version:1,productId:String(movement.productId),type:String(movement.type),date:Number(movement.date),qty,scope,before,after:value};
 return movement;
}
