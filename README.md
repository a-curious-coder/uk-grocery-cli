# open-supermarkets

**One command line for the world's supermarkets. Built for agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Stars](https://img.shields.io/github/stars/abracadabra50/open-supermarkets?style=social)](https://github.com/abracadabra50/open-supermarkets/stargazers)

Search real products at real prices, build a basket, book a slot, check out — across
retailers and across countries, from a terminal or from an AI agent over MCP.

```console
$ supermarket search "semi skimmed milk" --compare
  Tesco        Tesco Semi Skimmed Milk 2.27L          £1.45   in stock
  Sainsbury's  Sainsbury's British Semi Skimmed 2.2L  £1.45   in stock
  Ocado        Ocado Semi Skimmed Milk 2.27L          £1.50   in stock

$ supermarket search melk --country NL
  Arla Biologisch halfvolle melk 3-pack   €5.10    3 stuks
  Campina Langlekker halfvolle melk       €12.89   8 stuks

$ supermarket search "tesco semi skimmed milk 2l" --enrich
  Tesco Semi Skimmed Milk 2L   £1.45
    Nutri-Score B · allergens: milk · matched by name
```

Searching needs no API key in most countries, and no account at all in some.

---

## Why this exists

Supermarkets have no public API. So every meal planner, price tracker and shopping
agent reimplements the same brittle integration from scratch, for one country, and
abandons it six months later.

This is that layer, done once, in the open. Your agent decides *what* to buy. This
works out *where*, *how much*, and *how to actually order it*.

---

## Install

```bash
npm install -g open-supermarkets
supermarket providers
```

Or from source:

```bash
git clone https://github.com/abracadabra50/open-supermarkets.git
cd open-supermarkets && npm install
npx playwright install chromium   # only for browser-auth providers
npm link
```

The command is `supermarket`. If you used this when it was UK-only, `groc` still
works and prints a deprecation note — it is going away in v4 because the unrelated
`groc` npm package ships its own `groc` binary and the two cannot share a PATH.

---

## What works where

Providers declare capabilities honestly. Search is the easy part and needs no account
almost anywhere. Checkout needs an account, an address and a card, so it exists for
fewer.

| Provider | Country | Search | Basket | Slots | Checkout | Auth |
|---|---|:-:|:-:|:-:|:-:|---|
| Tesco | GB | ✓ | ✓ | ✓ | ✓ | browser session |
| Sainsbury's | GB | ✓ | ✓ | ✓ | ✓ | email + password |
| Ocado | GB | ✓ | ✓ | read-only | — | email + password |
| Albert Heijn | NL | ✓ | — | — | — | **none** |
| Kroger *(+ Ralphs, Fred Meyer, King Soopers, Harris Teeter, QFC)* | US | ✓ | — | — | — | official API key |
| Instacart | US / CA | ✓ | ✓ | — | via link | official API key |
| Instacart (unofficial) | US / CA | ✓ | ✓ | — | — | browser session |

`supermarket providers` prints this live, generated from the registry, so it cannot drift
from reality the way a hand-maintained table does.

Ocado's slot *booking* and checkout are blocked by AWS WAF bot detection as of
2026-07. Reading slots works; committing to one does not. The manifest doesn't claim
the capability, which is why the table shows a dash rather than a footnote.

**Open Food Facts enrichment works everywhere, for every provider, with no key** —
Nutri-Score, NOVA processing group, allergens and ingredients, from an open database
of several million products.

---

## Use it from an agent

This is the point of the project. It runs as an MCP server, so Claude, Cursor or
anything else speaking MCP can shop.

```json
{
  "mcpServers": {
    "groceries": { "command": "supermarket-mcp" }
  }
}
```

> "Cheapest way to get everything for a lasagne for six, and flag anything
> ultra-processed."

The agent searches across retailers, compares prices, checks NOVA groups and builds
the basket. You approve the checkout.

| MCP tool | What it does |
|---|---|
| `grocery_search` | Search one provider |
| `grocery_compare` | Same query across every provider in a country |
| `grocery_basket_view` · `_add` · `_remove` · `_update` · `_clear` | Basket operations |
| `grocery_slots` · `grocery_book_slot` | Delivery slots |
| `grocery_checkout` | Place the order (`dry_run` by default) |
| `grocery_orders` | Order history |
| `grocery_favourites` · `_search` | Favourites (Sainsbury's, Ocado) |
| `grocery_categories` · `grocery_browse` | Category browsing |
| `ocado_regulars` · `tesco_staples` | Repeat-purchase lists |
| `grocery_login` · `grocery_status` · `grocery_providers` | Session and discovery |

There's also `supermarket-api` for a plain HTTP server if you'd rather not speak MCP — useful
for agents with network access but no filesystem. See [SKILL.md](SKILL.md) and
[`skills/`](skills/) for the full reference.

---

## Only pay for the country you're in

Providers are declared in a manifest; their code loads on demand. Shopping in the UK
never loads the Dutch provider, and never pays Playwright's startup cost for a
retailer you don't use.

```ts
import { list, createProvider } from 'open-supermarkets';

list({ country: 'NL', capability: 'search' });  // loads no provider code at all
const ah = await createProvider('ah');          // loads exactly one
```

Country resolution: the `--country` flag, then `SUPERMARKET_COUNTRY`, then your system
locale.

---

## Add your supermarket

This is the growth model, and it's deliberately small. A search-only provider is one
file and one manifest entry — an afternoon's work.

**1. Write it.** Only `name` and `search()` are required.

```ts
export class MySupermarketProvider {
  readonly name = 'mysupermarket';
  async search(query: string, opts?: SearchOptions): Promise<Product[]> { /* ... */ }
}
```

**2. Register it** in `src/providers/registry.ts`:

```ts
{
  id: 'mysupermarket',
  label: 'My Supermarket',
  country: 'DE',
  capabilities: ['search'],
  auth: 'none',
  tier: 'community',
  maintainer: 'your-github-handle',
  load: async () => (await import('./mysupermarket')).MySupermarketProvider,
}
```

**3. Open a PR.** `src/providers/ah.ts` is the reference implementation — anonymous
token, catalogue search, about 150 lines, no account required.

**Before you start**, check [docs/providers/evaluated.md](docs/providers/evaluated.md).
It records what has already been probed and rejected, and why — REWE needs client
certificates extracted from its APK, Jumbo refuses the TLS handshake, DoorDash serves
an active Cloudflare challenge. Rejections are dated, so an old "no" is a reason to
re-probe rather than to stop.

### The rules that stop this rotting

- **Every provider has a maintainer of record.** Keeping fifty reverse-engineered
  integrations alive is not one person's job. No maintainer, the provider goes red,
  then archived. A status, not a judgement.
- **`core` is maintained here and exercised in CI. `community` is best-effort**, and
  labelled that way in the CLI so nobody is surprised at checkout.
- **Declare only what you implement.** A provider claiming a `checkout` it has never
  run is worse than one claiming nothing.
- **Credit the protocol.** If you learned the endpoints from someone else's reverse
  engineering, put it in the manifest's `credit` field. We do.

---

## Honest caveats

**Most of these are unofficial integrations.** Retailers change their APIs without
notice, and some deploy bot protection that will break things. A red provider is
usually that, not your setup.

**Automated access may conflict with a retailer's terms of service.** This is built
for personal automation — your account, your shopping. Read the terms of anything you
point it at and make your own call.

**Never trust name-matched allergen data.** Enrichment matches by barcode where a
provider exposes one, and by name where it doesn't. Name matches are guarded by a
similarity check and labelled `match: 'name'`, but a wrong match on an allergen is
dangerous in a way a wrong price is not. If it matters medically, read the packet.

**Checkout previews by default.** `supermarket checkout` shows you the order and
places nothing. Spending real money requires `--confirm`, explicitly. The MCP tool
behaves the same way (`dry_run` defaults to true).

---

## Credits

Protocol knowledge — reimplemented, not copied — from:

- [gwillem/appie-go](https://github.com/gwillem/appie-go) — Albert Heijn (Go, MIT)
- [kleinjm/instacart_api](https://github.com/kleinjm/instacart_api) — Instacart web (Ruby, MIT)
- [Open Food Facts](https://openfoodfacts.org) — global product data (ODbL)

Open Food Facts is a nonprofit, and this enrichment layer is free because volunteers
scanned several million products. If the project is useful to you,
[donate to them](https://donate.openfoodfacts.org).

MIT. Not affiliated with, endorsed by, or connected to any retailer named here.
