import { stripMovementsFromState } from './warehouse-movements.js';
import { stripPurchasesFromState } from './warehouse-purchases.js';
import { stripSalesFromState } from './warehouse-sales.js';
import { stripReservationsFromState } from './warehouse-reservations.js';
import { stripKaspiAdExpensesFromState } from './warehouse-kaspi-ads.js';
import { stripProductsFromState } from './warehouse-products.js';

const FINANCE_SETTING_KEYS = [
  'personalFinanceAccounts',
  'personalFinanceTransactions',
  'personalFinanceCategories',
  'personalFinanceLegacyImports'
];
const DERIVED_CACHE_KEYS = ['kaspiOrderFeed', 'wbOrderFeed', 'ozonOrderFeed', 'kaspiOrders', 'marketOrderState', 'marketplaceLiveSince'];

// Every writer must store this shape. Lists live in their own tables, and the
// old finance copy must not come back inside settings.
export function warehousePayloadForStorage(input) {
  const state = stripProductsFromState(stripKaspiAdExpensesFromState(stripReservationsFromState(stripSalesFromState(stripPurchasesFromState(stripMovementsFromState(input))))));
  if (state.settings && typeof state.settings === 'object' && !Array.isArray(state.settings)) {
    state.settings = { ...state.settings };
    for (const key of FINANCE_SETTING_KEYS) delete state.settings[key];
  }
  for (const key of DERIVED_CACHE_KEYS) delete state[key];
  return state;
}
