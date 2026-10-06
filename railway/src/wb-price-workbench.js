// The same price/discount model serves ordinary prices and promotion thresholds.
export function prepareWbPriceChange(row, input, pref = {}) {
  const present = value => value !== null && value !== undefined && value !== '';
  const action = String(input.action || 'price');
  if (!['price', 'enter', 'exit'].includes(action)) throw new Error('Неизвестное действие');
  const price = present(input.price) ? Number(input.price) : null;
  let discount = present(input.discount) ? Number(input.discount) : null;
  if (price !== null && (!Number.isInteger(price) || price <= 0)) throw new Error('Цена должна быть целым числом больше 0');
  if (price !== null && row.canEditPrice === false) throw new Error('Разные цены по размерам · меняется только скидка');
  if (action !== 'price' && price !== null) throw new Error('Для акции меняется только скидка');
  const base = Number(row.price);
  const plan = Number(pref.planPrice);
  if (discount === null && action === 'enter' && base > 0 && plan > 0) discount = Math.max(0, Math.ceil((1 - plan / base) * 100 - 1e-9));
  if (discount === null && action === 'exit') discount = 0;
  if (action === 'exit' && discount !== 0) throw new Error('Выход из акции обнуляет скидку и включает блок');
  if (discount !== null && (!Number.isInteger(discount) || discount < 0 || discount > 99)) throw new Error('Скидка должна быть целым числом от 0 до 99');
  if (action !== 'price' && discount === null) throw new Error('Порог акции неизвестен · укажите нужную скидку');
  if (action === 'enter' && plan > 0 && base * (1 - discount / 100) > plan + 1e-6) throw new Error('Этой скидки недостаточно для цены акции');
  if (price === null && discount === null) throw new Error('Укажите цену или скидку');
  return { price, discount, finalPrice: (price ?? base) * (1 - (discount ?? Number(row.discount)) / 100) };
}

export function nightUploadInFlight(queue) {
  return queue?.source === 'schedule' && (queue.status === 'sent' ||
    (queue.status === 'checking' && queue.lastError !== 'WB обработал загрузку, ждём отражения цены'));
}
