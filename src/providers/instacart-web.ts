/**
 * Instacart (US / Canada) — unofficial web GraphQL API.
 *
 * Use this when you do not have an official Developer Platform key. It talks to
 * the same GraphQL endpoint instacart.com's own web app uses, which means it can
 * actually search real products with real prices for a real address — something
 * the official API deliberately does not expose.
 *
 * The trade-offs are real and you should know them before depending on it:
 *
 *   • Login is bot-protected and cannot be scripted. You supply a session cookie
 *     captured from a browser you logged into yourself.
 *   • It sends Apollo *persisted queries*: an operation name plus a SHA-256 hash
 *     the server already knows. Those hashes are tied to an Instacart frontend
 *     build and rotate when they deploy. When that happens every call fails at
 *     once and the hashes below must be recaptured.
 *   • Automated access may be against Instacart's Terms of Service. This is here
 *     for personal automation. Decide for yourself.
 *
 * Protocol credit: github.com/kleinjm/instacart_api (Ruby, MIT). Endpoints,
 * headers, operation names and the persisted-query mechanism were read from that
 * project and reimplemented; no code was copied.
 *
 * ⚠️  NOT VERIFIED LIVE — writing this required an Instacart account and session
 *     cookie, which we do not have. The transport follows the documented shape.
 *     If you run it successfully, please say so on the issue tracker.
 */

import axios, { AxiosInstance } from 'axios';
import type { Basket, Product, SearchOptions } from './types';

const ENDPOINT = 'https://www.instacart.com/graphql';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Captured persisted-query hashes. These WILL go stale — they are pinned to an
 * Instacart frontend build, not to a stable API version. A blanket failure with
 * "PersistedQueryNotSupported" means recapture, not a bug in this file.
 *
 * Captured from kleinjm/instacart_api, 2026-08.
 */
const PERSISTED_QUERIES: Record<string, string> = {
  SearchCrossRetailerGroupResults:
    '0ef32d339ed761d8609b91d8232a26b7b6b05206baf32694c6fa47f7f8e73a33',
  Items: '9ad66078d7fa81276b6bd4eb6a6f6fcdd1f4022ff0c3f5b4663c62877f06692a',
  UpdateCartItemsMutation:
    'ba4bf465d294d1d528d82a4ac48ac13980d528149874c0e52082dc1d833bdb09',
  PersonalActiveCarts:
    'eac9d17bd45b099fbbdabca2e111acaf2a4fa486f2ce5bc4e8acbab2f31fd8c0',
};

export class StalePersistedQueryError extends Error {
  constructor(operation: string) {
    super(
      `Instacart rejected the persisted query for "${operation}".\n` +
        `This almost always means Instacart shipped a new frontend build and the\n` +
        `hashes in src/providers/instacart-web.ts are stale. Recapture them from\n` +
        `a browser session and open a PR — see docs/providers/instacart-web.md.`
    );
    this.name = 'StalePersistedQueryError';
  }
}

export class InstacartWebProvider {
  readonly name = 'instacart-web';

  private http: AxiosInstance;
  private zoneId?: string;
  private postalCode?: string;

  constructor(
    sessionCookie = process.env.INSTACART_SESSION_COOKIE,
    opts: { zoneId?: string; postalCode?: string } = {}
  ) {
    if (!sessionCookie) {
      throw new Error(
        'Instacart web needs a browser session cookie.\n' +
          'Set INSTACART_SESSION_COOKIE to the Cookie header from a logged-in\n' +
          'instacart.com tab (at minimum __Host-instacart_sid and its companions).\n' +
          'Their login is bot-protected, so this cannot be automated.'
      );
    }
    this.zoneId = opts.zoneId ?? process.env.INSTACART_ZONE_ID;
    this.postalCode = opts.postalCode ?? process.env.INSTACART_POSTAL_CODE;

    this.http = axios.create({
      timeout: 20_000,
      headers: {
        Cookie: sessionCookie,
        'User-Agent': USER_AGENT,
        // Without this the persisted-query resolver rejects the variables.
        'X-Client-Identifier': 'web',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  private extensions(operation: string) {
    const sha256Hash = PERSISTED_QUERIES[operation];
    if (!sha256Hash) {
      throw new StalePersistedQueryError(operation);
    }
    return { persistedQuery: { version: 1, sha256Hash } };
  }

  private unwrap(data: any, operation: string): any {
    const errors = data?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const message = errors.map((e: any) => e?.message).join('; ');
      if (/PersistedQueryNotSupported|PersistedQueryNotFound/i.test(message)) {
        throw new StalePersistedQueryError(operation);
      }
      throw new Error(`Instacart GraphQL error: ${message}`);
    }
    return data?.data;
  }

  /** Persisted queries go over GET with the payload in the query string. */
  private async query(operation: string, variables: Record<string, unknown>) {
    const { data } = await this.http.get(ENDPOINT, {
      params: {
        operationName: operation,
        variables: JSON.stringify(variables),
        extensions: JSON.stringify(this.extensions(operation)),
      },
    });
    return this.unwrap(data, operation);
  }

  /** Mutations go over POST with a JSON body. */
  private async mutate(operation: string, variables: Record<string, unknown>) {
    const { data } = await this.http.post(ENDPOINT, {
      operationName: operation,
      variables,
      extensions: this.extensions(operation),
    });
    return this.unwrap(data, operation);
  }

  private requireLocation(): { zoneId: string; postalCode: string } {
    if (!this.zoneId || !this.postalCode) {
      throw new Error(
        'Instacart web needs a delivery location to scope search and pricing.\n' +
          'Set INSTACART_POSTAL_CODE and INSTACART_ZONE_ID. Both appear in the\n' +
          'GraphQL request variables on instacart.com — open devtools and look at\n' +
          'any search request.'
      );
    }
    return { zoneId: this.zoneId, postalCode: this.postalCode };
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const { zoneId, postalCode } = this.requireLocation();
    const limit = options.limit ?? 10;

    const data = await this.query('SearchCrossRetailerGroupResults', {
      query,
      zoneId,
      postalCode,
      first: limit,
    });

    // The response nests differently across builds; probe the known shapes
    // rather than assuming one and returning silently-empty results.
    const groups =
      data?.searchCrossRetailerGroupResults?.groups ??
      data?.searchCrossRetailerGroupResults?.results ??
      [];

    const products: Product[] = [];
    for (const group of groups) {
      for (const item of group?.items ?? group?.products ?? []) {
        products.push({
          product_uid: String(item?.id ?? item?.legacyId ?? ''),
          name: item?.name ?? item?.displayName ?? '(unnamed)',
          retail_price: {
            price: Number(item?.pricing?.price ?? item?.price ?? 0),
          },
          in_stock: item?.available !== false,
          currency: 'USD',
          image_url: item?.viewSection?.itemImage?.url ?? item?.imageUrl,
          provider: this.name,
          size: item?.size ?? item?.packSize,
        });
        if (products.length >= limit) return products;
      }
    }
    return products;
  }

  async getBasket(): Promise<Basket> {
    const data = await this.query('PersonalActiveCarts', {});
    const carts = data?.personalActiveCarts ?? [];
    const items = (carts[0]?.items ?? []).map((i: any, idx: number) => ({
      item_id: String(i?.id ?? idx),
      product_uid: String(i?.itemId ?? i?.id ?? ''),
      name: i?.name ?? '(unnamed)',
      quantity: Number(i?.quantity ?? 1),
      unit_price: Number(i?.pricing?.unitPrice ?? 0),
      total_price: Number(i?.pricing?.total ?? 0),
    }));

    return {
      items,
      total_quantity: items.reduce((n: number, i: any) => n + i.quantity, 0),
      total_cost: items.reduce((n: number, i: any) => n + i.total_price, 0),
      provider: this.name,
    };
  }

  async addToBasket(productId: string, quantity = 1): Promise<void> {
    const { zoneId } = this.requireLocation();
    await this.mutate('UpdateCartItemsMutation', {
      zoneId,
      items: [{ itemId: productId, quantity }],
    });
  }

  async removeFromBasket(itemId: string): Promise<void> {
    await this.addToBasket(itemId, 0);
  }
}
