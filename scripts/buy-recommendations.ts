/**
 * "What to buy next" — derives a due-for-reorder list from real order
 * history: average days between purchases per product, days since it was
 * last bought, and the most recent price paid.
 *
 * A product is "due" once today has passed its average interval since the
 * last order that contained it. This is a simple heuristic, not a forecast
 * model — it only has ~12 orders of history to learn from, so treat it as a
 * prompt to check, not a guarantee.
 *
 * Run with: npx tsx scripts/buy-recommendations.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DATA_DIR = path.join(os.homedir(), 'grocery-data');
const PROVIDER = 'tesco';
const DAY_MS = 86400000;

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';

function loadJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
}

interface Rec {
  name: string;
  timesOrdered: number;
  avgIntervalDays: number;
  daysSinceLast: number;
  dueInDays: number; // negative = overdue
  lastUnitCost: number | null;
}

function main() {
  const orders: any[] = loadJson<any>('orders.json')[PROVIDER] || [];
  const products: Record<string, any> = loadJson<any>('products.json')[PROVIDER] || {};
  const delivered = orders.filter(o => o.status !== 'Cancelled');
  const now = Date.now();

  const recs: Rec[] = [];
  for (const [pid, p] of Object.entries(products) as [string, any][]) {
    if (p.times_seen < 2) continue; // no pattern to learn from a single purchase

    const occurrences = delivered
      .filter(o => o.items.some((i: any) => i.product_id === pid))
      .map(o => ({ date: new Date(o.date).getTime(), item: o.items.find((i: any) => i.product_id === pid) }))
      .sort((a, b) => a.date - b.date);
    if (occurrences.length < 2) continue;

    const gaps = occurrences.slice(1).map((o, i) => (o.date - occurrences[i].date) / DAY_MS);
    const avgIntervalDays = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const last = occurrences[occurrences.length - 1];
    const daysSinceLast = (now - last.date) / DAY_MS;
    const lastCost = last.item?.cost;
    const lastQty = last.item?.quantity || 1;

    recs.push({
      name: p.name,
      timesOrdered: p.times_seen,
      avgIntervalDays,
      daysSinceLast,
      dueInDays: avgIntervalDays - daysSinceLast,
      lastUnitCost: lastCost != null ? lastCost / lastQty : null,
    });
  }

  // Urgency relative to the product's own rhythm, not raw days — otherwise
  // a once-every-3-months item and a weekly staple both bought 60 days ago
  // look equally "overdue" when only one of them actually is.
  const urgency = (r: Rec) => r.daysSinceLast / r.avgIntervalDays;
  recs.sort((a, b) => urgency(b) - urgency(a));

  const overdue = recs.filter(r => r.dueInDays < 0);
  const dueSoon = recs.filter(r => r.dueInDays >= 0 && r.dueInDays <= 7);
  const notYet = recs.filter(r => r.dueInDays > 7);

  const daysSinceLastOrder = delivered.length
    ? (now - Math.max(...delivered.map(o => new Date(o.date).getTime()))) / DAY_MS
    : 0;

  console.log(`\n${BOLD}What to buy next — ${PROVIDER}${RESET}`);
  console.log(`${DIM}Based on ${delivered.length} past orders. A due date is a prompt to check, not a guarantee.${RESET}`);
  if (daysSinceLastOrder > 30) {
    console.log(`${YELLOW}Last order was ${Math.round(daysSinceLastOrder)} days ago — most regulars will show as overdue as a result, this isn't a per-item signal.${RESET}`);
  }

  const printGroup = (title: string, color: string, items: Rec[], cap?: number) => {
    if (!items.length) return;
    console.log(`\n${BOLD}${color}${title}${RESET}`);
    const shown = cap ? items.slice(0, cap) : items;
    for (const r of shown) {
      const cost = r.lastUnitCost != null ? `~£${r.lastUnitCost.toFixed(2)}` : 'price unknown';
      const due = r.dueInDays < 0
        ? `${Math.abs(Math.round(r.dueInDays))}d overdue`
        : `due in ${Math.round(r.dueInDays)}d`;
      console.log(`  ${r.name}`);
      console.log(`    ${DIM}${due} · usually every ${Math.round(r.avgIntervalDays)}d · ${cost} · bought ${r.timesOrdered}x${RESET}`);
    }
    if (cap && items.length > cap) {
      console.log(`  ${DIM}+${items.length - cap} more${RESET}`);
    }
  };

  printGroup('Most overdue, relative to their own rhythm (top 10)', RED, overdue, 10);
  printGroup('Due within a week', YELLOW, dueSoon);
  printGroup('Not due yet (next 3)', GREEN, notYet.slice(0, 3));

  const estimatedCost = [...overdue, ...dueSoon].reduce((a, r) => a + (r.lastUnitCost || 0), 0);
  console.log(`\n${DIM}Estimated cost to cover everything overdue + due this week (${overdue.length + dueSoon.length} items): ${RESET}${BOLD}£${estimatedCost.toFixed(2)}${RESET}\n`);
}

main();
