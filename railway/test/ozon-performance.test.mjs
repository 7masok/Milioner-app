import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOzonMoney, skuSpendFromProductReport, skuSpendFromReport, skuSpendFromSkuStats } from '../src/ozon-performance.js';

test('Ozon performance money uses a comma decimal', () => {
  assert.equal(parseOzonMoney('7552,97'), 7552.97);
  assert.equal(parseOzonMoney(''), 0);
});

test('Ozon performance report spend stays on the advertised SKU', () => {
  const rows = skuSpendFromReport({
    42307860: { report: { rows: [
      { sku: '4161397839', title: 'Зёрна', moneySpent: '1000,50', orders: '1' },
      { sku: '4161397839', title: 'Зёрна', moneySpent: '10,00', orders: '0' },
      { sku: '2', title: 'Манго', moneySpent: '0,00', orders: '0' }
    ] } }
  });
  assert.deepEqual(rows, [{ sku: '4161397839', title: 'Зёрна', spent: 1010.5, orders: 1 }]);
});


test('direct Ozon SKU statistics aggregate real expense by SKU',()=>{
  const rows=skuSpendFromSkuStats({rows:[
    {sku:'100',expense:'120.50',orders:'2'},
    {sku:'100',expense:'30,25',orders:'1'},
    {sku:'200',expense:'0',orders:'0'}
  ]});
  assert.deepEqual(rows,[{sku:'100',title:'',spent:150.75,orders:3}]);
});

test('fallback Ozon product report keeps spend on SKU',()=>{
  const rows=skuSpendFromProductReport({
    report:{rows:[
      {sku:'501',name:'Товар 501',expense:'75.5',orders:'1'},
      {sku:'502',name:'Товар 502',expense:'0',orders:'0'}
    ]}
  });
  assert.deepEqual(rows,[{sku:'501',title:'Товар 501',spent:75.5,orders:1}]);
});
