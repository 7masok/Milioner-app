import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedProduct, stripProductsFromState } from '../src/warehouse-products.js';

test('products leave the warehouse document but keep their stock', () => {
  const next = stripProductsFromState({
    settings: { currency: 'KZT' },
    products: [{ id: 'a', name: 'Товар', stock: 4, kaspi: 'SKU-1' }]
  });
  assert.equal(next.products, undefined);
  assert.equal(next.settings.currency, 'KZT');
});

test('a product without an id is not stored', () => {
  const product = normalizedProduct({ id: 'a', name: 'Товар', stock: '4', kaspi: 'SKU-1', photo: 'data:image/jpeg;base64,xx' });
  assert.equal(product.stock, 4);
  assert.equal(product.kaspi, 'SKU-1');
  assert.equal(product.photo.startsWith('data:image'), true);
  assert.equal(normalizedProduct({ name: 'без номера' }), null);
});
