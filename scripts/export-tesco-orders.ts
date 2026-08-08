/**
 * Personal data sync: pull Tesco order history into a small local store for
 * analysis/insights (spending trends, eating habits, etc).
 *
 * Two files, not one — products are deduped and referenced by ID rather than
 * repeated on every order line, and the product catalogue upserts (grows
 * richer over time as more orders/syncs touch the same items) while orders
 * are append/replace-by-id. Both are plain JSON: no DB tooling needed to
 * read them, an LLM (or a five-line script) can just load and join.
 *
 * Not a CLI command, not for the PR — this is Callum's own tool, output
 * deliberately written outside the repo so it's never at risk of being
 * committed to the (now-forked/PR'd) public repo.
 *
 * Run with: npx tsx scripts/export-tesco-orders.ts
 *
 * ponytail: item.cost is splitView's per-line paid price, which reconciles
 * exactly against order.total on ~5/13 known orders and is off by a few
 * pounds on the rest — likely substitutions/promotions applied post-checkout
 * that this flat view doesn't carry. Good enough for trend analysis; if
 * penny-accurate totals matter later, pull `diagnostics`/`discounts` off the
 * receipt query too.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TescoProvider } from '../src/providers/tesco';

const OUT_DIR = path.join(os.homedir(), 'grocery-data');
const PRODUCTS_FILE = path.join(OUT_DIR, 'products.json');
const ORDERS_FILE = path.join(OUT_DIR, 'orders.json');
const PROVIDER = 'tesco';

type ProductStore = Record<string, Record<string, any>>; // provider -> tpnc -> product
type OrderStore = Record<string, any[]>; // provider -> orders[]

function loadJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/** Upsert product identity only (name/tpnb) — safe to call multiple times per run. */
function upsertProductIdentity(products: ProductStore, provider: string, tpnc: string, tpnb: string, name: string) {
  if (!tpnc) return;
  products[provider] ||= {};
  const existing = products[provider][tpnc];
  if (existing) {
    if (name) existing.name = name; // names occasionally change pack size etc — keep latest
    if (tpnb) existing.tpnb = tpnb;
  } else {
    products[provider][tpnc] = { tpnb, name };
  }
}

/**
 * times_seen/first_seen/last_seen are derived from orders.json, not
 * incremented during the sync loop — a counter that goes up every time you
 * run the script (even for orders it already knew about) drifts on every
 * re-run. Deriving from final state is idempotent by construction.
 */
function recomputeProductStats(products: ProductStore, orderStore: OrderStore) {
  for (const provider of Object.keys(orderStore)) {
    const stats: Record<string, { count: number; first: string; last: string }> = {};
    for (const order of orderStore[provider]) {
      for (const item of order.items) {
        if (!item.product_id) continue;
        const s = stats[item.product_id] ||= { count: 0, first: order.date, last: order.date };
        s.count += 1;
        if (order.date < s.first) s.first = order.date;
        if (order.date > s.last) s.last = order.date;
      }
    }
    for (const [pid, s] of Object.entries(stats)) {
      if (!products[provider]?.[pid]) continue;
      products[provider][pid].times_seen = s.count;
      products[provider][pid].first_seen = s.first;
      products[provider][pid].last_seen = s.last;
    }
  }
}

/**
 * ponytail: pending/upcoming orders aren't returned by orderSearch under any
 * status enum tried, including the order's own real status ("Pending") —
 * that endpoint appears to only index completed orders, full stop. The one
 * place the ID is visible is the server-rendered /orders/upcoming page, so
 * scrape *only the order ID* from there — one small regex, minimal surface
 * area — then hand it to the same getOrder() GraphQL call used for every
 * other order, which returns full clean data (status, total, slot, priced
 * items) regardless of order status. If Tesco changes this page's markup,
 * this ID lookup silently returns nothing and pending orders just don't
 * sync until the fix branch here gets updated — not a hard failure.
 */
async function scrapeUpcomingOrderIds(api: any): Promise<string[]> {
  try {
    const resp = await api.client.get('https://www.tesco.com/shop/en-GB/orders/upcoming', {
      headers: { Accept: 'text/html' },
    });
    return [...(resp.data as string).matchAll(/data-testid="order-item" id="([\w-]+)"/g)].map(m => m[1]);
  } catch (err: any) {
    console.warn(`  ⚠️  Could not fetch upcoming-orders page: ${err.message}`);
    return [];
  }
}

async function main() {
  const provider = new TescoProvider();
  const api = provider.getAPI();

  const products: ProductStore = loadJson(PRODUCTS_FILE, {});
  const orderStore: OrderStore = loadJson(ORDERS_FILE, {});
  orderStore[PROVIDER] ||= [];
  const existingOrderIds = new Set(orderStore[PROVIDER].map((o: any) => o.order_id));

  console.log('Fetching order list...');
  const summary = await api.getOrders(1, 50); // Tesco caps history; 50 covers it
  const rawOrders: any[] = summary?.orders || [];

  const knownOrderNos = new Set(rawOrders.map(o => o.orderNo || o.id));
  const upcomingIds = (await scrapeUpcomingOrderIds(api)).filter(id => !knownOrderNos.has(id));
  for (const id of upcomingIds) rawOrders.push({ orderNo: id }); // receipt supplies everything else

  console.log(`Found ${rawOrders.length} orders (${upcomingIds.length} pending/upcoming). Fetching full line-item detail for each...`);

  const syncedOrders = [];
  for (const o of rawOrders) {
    const orderNo = o.orderNo || o.id;
    let receipt: any = null;
    try {
      receipt = await api.getOrder(orderNo);
    } catch (err: any) {
      console.warn(`  ⚠️  Failed to fetch detail for order ${orderNo}: ${err.message}`);
    }

    // splitView comes back as an array (single-element) or a bare object depending
    // on order — same inconsistency the basket endpoint has, handled the same way.
    const splitView = Array.isArray(receipt?.splitView) ? receipt.splitView[0] : receipt?.splitView;
    const rawItems = splitView?.items?.length ? splitView.items : (o.items || []);

    const items = rawItems.map((i: any) => {
      const tpnc = String(i.product?.tpnc || '');
      const tpnb = String(i.product?.tpnb || '');
      const name = i.product?.title || '';
      upsertProductIdentity(products, PROVIDER, tpnc, tpnb, name);
      return {
        product_id: tpnc || null, // join key into products.json[tesco]
        quantity: i.quantity ?? null,
        cost: i.cost ?? null, // actual amount paid for this line, null if unavailable
      };
    });

    // The receipt query always requests status/createdDateTime/totalPrice/slot
    // itself, so prefer it over the summary object — which doesn't exist at
    // all for orders only discovered via scrapeUpcomingOrderIds().
    const slot = receipt?.slot ?? o.slot;
    syncedOrders.push({
      order_id: orderNo,
      status: receipt?.status ?? o.status,
      date: receipt?.createdDateTime ?? o.createdDateTime,
      total: receipt?.totalPrice ?? o.totalPrice,
      delivery: slot ? { start: slot.start, end: slot.end, charge: slot.charge } : null,
      items,
    });

    process.stdout.write('.');
  }
  console.log('\nDone.');

  // Replace-by-id: keep prior orders not seen this run (e.g. if a page was
  // missed), overwrite ones we just re-fetched.
  const newIds = new Set(syncedOrders.map(o => o.order_id));
  orderStore[PROVIDER] = [
    ...orderStore[PROVIDER].filter((o: any) => !newIds.has(o.order_id)),
    ...syncedOrders,
  ];

  recomputeProductStats(products, orderStore);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orderStore, null, 2));

  const newOrderCount = syncedOrders.filter(o => !existingOrderIds.has(o.order_id)).length;
  console.log(`Synced ${syncedOrders.length} orders (${newOrderCount} new) and ${Object.keys(products[PROVIDER] || {}).length} distinct products.`);
  console.log(`Products: ${PRODUCTS_FILE}`);
  console.log(`Orders:   ${ORDERS_FILE}`);
}

main().catch(err => {
  console.error('Export failed:', err.message);
  process.exit(1);
});
