/**
 * Terminal dashboard over ~/grocery-data/{products,orders}.json.
 *
 * Zero dependencies — hand-rolled ANSI/block-character bars. A charting
 * library would be overkill for a handful of horizontal bar charts; the
 * terminal already does color and Unicode blocks natively.
 *
 * Run with: npx tsx scripts/insights.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DATA_DIR = path.join(os.homedir(), 'grocery-data');
const PROVIDER = 'tesco';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

function loadJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
}

function bar(value: number, max: number, width: number, color = GREEN): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return color + '█'.repeat(filled) + DIM + '░'.repeat(width - filled) + RESET;
}

function header(title: string) {
  console.log(`\n${BOLD}${CYAN}${title}${RESET}`);
  console.log(DIM + '─'.repeat(title.length) + RESET);
}

function main() {
  const orders: any[] = loadJson<any>('orders.json')[PROVIDER] || [];
  const products: Record<string, any> = loadJson<any>('products.json')[PROVIDER] || {};

  const delivered = orders.filter(o => o.status !== 'Cancelled').sort((a, b) => a.date.localeCompare(b.date));
  const cancelled = orders.filter(o => o.status === 'Cancelled');

  console.log(`\n${BOLD}📊 Grocery Insights — ${PROVIDER}${RESET}`);
  console.log(`${DIM}${orders.length} orders synced, ${Object.keys(products).length} distinct products${RESET}`);

  // ── Spend by month ──────────────────────────────────────
  const byMonth: Record<string, number> = {};
  for (const o of delivered) {
    const month = o.date.slice(0, 7);
    byMonth[month] = (byMonth[month] || 0) + o.total;
  }
  const months = Object.keys(byMonth).sort();
  const maxMonthSpend = Math.max(...Object.values(byMonth));

  header('Spend by month');
  for (const m of months) {
    const spend = byMonth[m];
    console.log(`  ${m}  ${bar(spend, maxMonthSpend, 30)}  ${YELLOW}£${spend.toFixed(2)}${RESET}`);
  }

  // ── Order cadence ───────────────────────────────────────
  const dates = delivered.map(o => new Date(o.date).getTime());
  const gaps = dates.slice(1).map((d, i) => Math.round((d - dates[i]) / 86400000));
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const avgSpend = delivered.reduce((a, o) => a + o.total, 0) / delivered.length;
  const total = delivered.reduce((a, o) => a + o.total, 0);

  header('Order cadence');
  console.log(`  ${delivered.length} delivered orders${cancelled.length ? DIM + `, ${cancelled.length} cancelled` + RESET : ''}`);
  console.log(`  Avg every ${BOLD}${avgGap.toFixed(1)} days${RESET}  (min ${Math.min(...gaps)}, max ${Math.max(...gaps)})`);
  console.log(`  Avg order: ${BOLD}£${avgSpend.toFixed(2)}${RESET}   Total: ${BOLD}£${total.toFixed(2)}${RESET}`);

  // ── Top repeat buys ──────────────────────────────────────
  const top = Object.values(products)
    .filter((p: any) => p.times_seen > 1)
    .sort((a: any, b: any) => b.times_seen - a.times_seen)
    .slice(0, 12);
  const maxSeen = Math.max(...top.map((p: any) => p.times_seen));
  const nameWidth = Math.min(38, Math.max(...top.map((p: any) => p.name.length)));

  header(`Top repeat buys (of ${delivered.length} orders)`);
  for (const p of top as any[]) {
    const name = p.name.length > nameWidth ? p.name.slice(0, nameWidth - 1) + '…' : p.name.padEnd(nameWidth);
    console.log(`  ${name}  ${bar(p.times_seen, maxSeen, 20, CYAN)}  ${p.times_seen}/${delivered.length}`);
  }

  console.log();
}

main();
