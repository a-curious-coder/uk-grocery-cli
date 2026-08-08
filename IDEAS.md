# Ideas

Unsorted feature/contribution ideas. Not commitments — a scratchpad for what's worth building.

## Upstream-able (fix, PR to original repo)

- **Tesco order history was a dead stub.** `getOrders()`/`getOrder()` hit a REST URL
  that's actually a webpage, not an API — always silently returned empty. Fixed
  locally by switching to the real `GetPreviousOrdersWithPagination` /
  `GetOrderReceipt` GraphQL queries against `xapi.tesco.com` (discovered via
  DevTools network capture). Ready to PR.
- **`groc remove` / `groc update` take the wrong ID.** Documented as taking the
  basket item ID (the barcode-style `item_id`), but the Tesco provider actually
  needs `product_uid`. Currently fails silently — CLI prints "✅ Removed" even
  when nothing changed. Needs either a fix to accept item_id, or a doc/error-message
  correction. Same root cause bit us mid-session (added premium swaps, they didn't
  remove, basket silently doubled up).
- **Audit Sainsbury's/Ocado for the same "looks implemented, isn't" pattern.**
  Ocado's README claims GraphQL order history works — worth verifying it's not
  another dead stub before relying on it.
- **Silent `catch { return null }` in api.ts hides real errors.** Made the original
  order-history bug much harder to diagnose — a 500 or a schema mismatch looks
  identical to "no orders". Worth surfacing the actual error (or at least logging
  it) rather than swallowing.

## Personal analytics (own data, no fork needed)

- **Local SQLite of order history.** Walk `getOrders()` pages → `getOrder()` per
  order for full line-item detail → store in a local DB:
  - `orders(order_id, provider, status, total, created_at, delivery_start, delivery_end)`
  - `order_items(order_id, product_uid, name, quantity, unit, weight)`
  - Re-fetchable/idempotent (upsert on order_id) so it can run as a periodic sync.
  - **Lesson learned building it**: derived stats (times_seen, first/last_seen)
    must be *recomputed* from the final order set on every sync, not incremented
    during the sync loop — an incrementing counter silently doubles every time
    the script re-runs over already-known orders. Bit us: beef mince showed
    "18x" when the real answer was 9. Any per-product/per-category aggregate in
    this kind of store should be a derived view, not mutable accumulated state.
  - Built as two JSON files, not SQLite — `products.json` (catalog, keyed by
    provider→product ID, upserts) + `orders.json` (orders referencing products
    by ID). Plain-JSON was chosen deliberately over a DB so an LLM (or a five-line
    script) can read/join it directly with no query tooling. Lives in
    `scripts/export-tesco-orders.ts` on the fork, output in `~/grocery-data/`
    (never in the repo — it's Callum's real purchase/spend history).
- **Spending trends over time** — total spend/week, spend by category (once
  category data is captured), premium-vs-value ratio over time.
- **Eating habit signals from order data alone** — order frequency (weekly?
  ad-hoc?), basket size variance, repeat-item detection (proxy for staples/meal
  rotation), gaps between orders (skipped weeks).
- **Nutrition/protein tracking is a harder problem** — Tesco's API doesn't expose
  nutrition panels in the order/search data seen so far. Would need a separate
  product-nutrition lookup (own scraping, or a food DB API) keyed off product_uid/gtin.
  Flag as a real unknown, not assumed solvable with current data.

## Preference/goals engine (bigger, speculative)

- **User goal profile**: bulk / cut / maintain, budget ceiling, protein-per-meal
  targets, meal-prep cadence (plans ahead vs. reactive shopping) — captured once,
  referenced on every basket-building session instead of re-asking each time.
- **Tier toggle: CHEAP / MODERATE / PREMIUM** — a per-category price/quality
  dial (own-brand vs. mid-tier vs. Finest-equivalent) rather than deciding item-by-item
  by hand, which is what this session did manually. Formalizing it means the
  Chicken/Beef/Pork/Rice/Pasta swap logic from this session becomes reusable
  instead of one-off judgement calls.
- **Decision matrix**: goal × tier × meal-prep-cadence → shopping list template.
  E.g. (cut, cheap, plans-ahead) → high-veg, batch-cooked, own-brand lean protein;
  (bulk, premium, reactive) → bigger portions, Finest-tier protein, less batching.
- This is speculative and the highest-effort item on this list — worth prototyping
  against real order-history data (once the local DB exists) before committing to
  a design, rather than designing it blind.

## Notes

- Order-history fix and item-ID bug were both found live in this session while
  doing basket edits for Callum — not theoretical, both reproduced with real
  basket state.
- Multi-provider spend aggregation (Tesco + Sainsbury's + Ocado in one view) is
  a natural extension once at least two providers have working order history.
