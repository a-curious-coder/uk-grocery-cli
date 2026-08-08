/**
 * Raw reorder statistics per product — arithmetic only, no judgment calls.
 *
 * For each product bought more than once: how often it's usually bought,
 * how long since the last purchase, and the last price paid. No "overdue"
 * labels, no thresholds, no ranking — those are interpretation, and belong
 * at question-time (factoring in GOALS.md, what's already in the basket,
 * whatever's actually being asked that day), not frozen into this script.
 *
 * Outputs JSON to stdout.
 *
 * Run with: npx tsx scripts/reorder-stats.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DATA_DIR = path.join(os.homedir(), 'grocery-data');
const PROVIDER = 'tesco';
const DAY_MS = 86400000;

function loadJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
}

function main() {
  const orders: any[] = loadJson<any>('orders.json')[PROVIDER] || [];
  const products: Record<string, any> = loadJson<any>('products.json')[PROVIDER] || {};
  const delivered = orders.filter(o => o.status !== 'Cancelled');
  const now = Date.now();

  const stats = [];
  for (const [pid, p] of Object.entries(products) as [string, any][]) {
    if (p.times_seen < 2) continue; // no interval to measure from a single purchase

    const occurrences = delivered
      .filter(o => o.items.some((i: any) => i.product_id === pid))
      .map(o => ({ date: new Date(o.date).getTime(), item: o.items.find((i: any) => i.product_id === pid) }))
      .sort((a, b) => a.date - b.date);
    if (occurrences.length < 2) continue;

    const gaps = occurrences.slice(1).map((o, i) => (o.date - occurrences[i].date) / DAY_MS);
    const avg_interval_days = Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10;
    const last = occurrences[occurrences.length - 1];
    const days_since_last = Math.round(((now - last.date) / DAY_MS) * 10) / 10;
    const lastQty = last.item?.quantity || 1;
    const last_unit_cost = last.item?.cost != null ? Math.round((last.item.cost / lastQty) * 100) / 100 : null;

    stats.push({
      product_id: pid,
      name: p.name,
      times_ordered: p.times_seen,
      avg_interval_days,
      days_since_last,
      last_ordered: new Date(last.date).toISOString().slice(0, 10),
      last_unit_cost,
    });
  }

  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    orders_analysed: delivered.length,
    last_order_date: delivered.length
      ? new Date(Math.max(...delivered.map(o => new Date(o.date).getTime()))).toISOString().slice(0, 10)
      : null,
    products: stats,
  }, null, 2));
}

main();
