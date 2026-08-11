/**
 * Money formatting, shared by the CLI, the MCP server and the HTTP API.
 *
 * This lives in its own module because the pound sign was previously hardcoded
 * in a dozen places across three entrypoints. That was harmless while the
 * project was UK-only and became a correctness bug the moment it wasn't — an
 * Instacart basket reporting dollars as pounds is worse than no total at all.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
  CAD: 'CA$',
  AUD: 'A$',
  PLN: 'zł',
  SEK: 'kr',
  CHF: 'CHF ',
};

/**
 * Symbol for a currency code, falling back to the code itself so an unmapped
 * currency reads as "BRL 12.00" rather than silently claiming to be sterling.
 */
export function sym(currency?: string): string {
  const code = currency ?? 'GBP';
  return CURRENCY_SYMBOLS[code] ?? `${code} `;
}

/** Format an amount as a price: two decimals, correct symbol. */
export function money(amount: number, currency?: string): string {
  return `${sym(currency)}${Number(amount ?? 0).toFixed(2)}`;
}
