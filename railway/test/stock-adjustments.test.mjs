import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const lines = html.split('\n');

function frontendFunction(name) {
  const source = lines.find(line => line.startsWith(`function ${name}(`));
  assert.ok(source, `Missing frontend function ${name}`);
  return source;
}

function runFrontendFunction(name, context) {
  vm.createContext(context);
  vm.runInContext(frontendFunction(name), context);
  vm.runInContext(`${name}()`, context);
}

test('writeoff can record reserved stock as a physical shortage', () => {
  const product = { id: 'p1', stock: 5 };
  const movements = [];
  const alerts = [];
  const fields = {
    wp: { value: 'p1' },
    wq: { value: '2' },
    wr: { value: 'Недостача' },
  };

  runFrontendFunction('createWriteoff', {
    document: { getElementById: id => fields[id] || null },
    prod: id => id === product.id ? product : null,
    isBundleProduct: () => false,
    reserved: () => 5,
    fifoConsume: (_id, qty) => ({ totalCost: qty * 100 }),
    refreshProductAverageCost: () => {},
    fmt: value => `${value} ₸`,
    log: (...args) => movements.push(args),
    save: () => true,
    closeModal: () => {},
    render: () => {},
    alert: message => alerts.push(message),
  });

  assert.equal(product.stock, 3);
  assert.deepEqual(alerts, []);
  assert.equal(movements.length, 1);
  assert.match(movements[0][3], /нехватка по активным заказам 2 шт\./);
});

test('writeoff never goes below the physical stock', () => {
  const product = { id: 'p1', stock: 5 };
  const alerts = [];
  const fields = {
    wp: { value: 'p1' },
    wq: { value: '6' },
    wr: { value: 'Недостача' },
  };

  runFrontendFunction('createWriteoff', {
    document: { getElementById: id => fields[id] || null },
    prod: id => id === product.id ? product : null,
    isBundleProduct: () => false,
    reserved: () => 5,
    fifoConsume: () => { throw new Error('FIFO must not change'); },
    refreshProductAverageCost: () => {},
    fmt: String,
    log: () => {},
    save: () => true,
    closeModal: () => {},
    render: () => {},
    alert: message => alerts.push(message),
  });

  assert.equal(product.stock, 5);
  assert.deepEqual(alerts, ['Нельзя списать больше фактического остатка. На складе: 5 шт.']);
});

test('inventory accepts a physical count below active reservations', () => {
  const product = { id: 'p1', stock: 5, cost: 100 };
  const movements = [];
  const alerts = [];
  const consumed = [];
  const fields = {
    ip: { value: 'p1' },
    iq: { value: '3' },
    icost: { value: '125' },
  };

  runFrontendFunction('doInventory', {
    document: { getElementById: id => fields[id] || null },
    prod: id => id === product.id ? product : null,
    isBundleProduct: () => false,
    reserved: () => 5,
    fifoLots: () => [],
    fifoConsume: (id, qty) => consumed.push([id, qty]),
    refreshProductAverageCost: () => {},
    state: { purchases: [] },
    id: () => 'inventory-lot',
    fmt: value => `${value} ₸`,
    log: (...args) => movements.push(args),
    save: () => true,
    closeModal: () => {},
    render: () => {},
    alert: message => alerts.push(message),
    MILLIONER_API: '',
  });

  assert.equal(product.stock, 3);
  assert.equal(product.cost, 125);
  assert.deepEqual(consumed, [['p1', 2]]);
  assert.deepEqual(alerts, []);
  assert.match(movements[0][3], /нехватка по активным заказам 2 шт\./);
});
