/**
 * Kroger (United States) — official Public Products API.
 *
 * The best-behaved provider in this repo. Everything else here is reverse
 * engineered against a site that would rather we didn't; Kroger publishes a
 * documented API, hands out credentials through self-serve registration, and
 * states its rate limit up front (10,000 calls/day).
 *
 * It is also the widest single US integration available. Kroger operates Ralphs,
 * Fred Meyer, King Soopers, Harris Teeter, Smith's, QFC, Food4Less and others —
 * one set of credentials covers all of them.
 *
 *   Register:  https://developer.kroger.com   → Client ID + Client Secret
 *   Docs:      https://developer.kroger.com/reference/
 *
 * Auth is OAuth2 *client_credentials* with scope `product.compact` — an
 * application token, not a user login. Nobody signs in, no cookie expires, no
 * bot challenge. That makes it the only US provider here usable unattended.
 *
 * ⚠️  NOT VERIFIED LIVE — credentials require registering an application, which
 *     needs the repo owner's details. Written against the published API
 *     reference and the endpoint shapes used by the Python client
 *     (github.com/CupOfOwls/kroger-api, MIT). Everything is documented rather
 *     than guessed, but the response mapping is unconfirmed until someone runs
 *     it with a key.
 */

import axios, { AxiosInstance } from 'axios';
import type { Product, SearchOptions } from './types';

const API_BASE = 'https://api.kroger.com';
const TOKEN_PATH = '/v1/connect/oauth2/token';
const PRODUCTS_PATH = '/v1/products';
const LOCATIONS_PATH = '/v1/locations';

/** Read-only product access. Cart and profile scopes need a real user login. */
const SCOPE = 'product.compact';

interface KrogerItem {
  price?: { regular?: number; promo?: number };
  size?: string;
  soldBy?: string;
  inventory?: { stockLevel?: string };
  fulfillment?: Record<string, boolean>;
}

interface KrogerProduct {
  productId: string;
  upc?: string;
  description?: string;
  brand?: string;
  items?: KrogerItem[];
  images?: Array<{ sizes?: Array<{ size?: string; url?: string }> }>;
}

export class KrogerProvider {
  readonly name = 'kroger';

  private http: AxiosInstance;
  private clientId: string;
  private clientSecret: string;
  private locationId?: string;

  private token?: string;
  private tokenExpiry = 0;

  constructor(
    clientId = process.env.KROGER_CLIENT_ID,
    clientSecret = process.env.KROGER_CLIENT_SECRET,
    locationId = process.env.KROGER_LOCATION_ID
  ) {
    if (!clientId || !clientSecret) {
      throw new Error(
        'Kroger needs API credentials. Set KROGER_CLIENT_ID and KROGER_CLIENT_SECRET.\n' +
          'Registration is self-serve and free at https://developer.kroger.com —\n' +
          'create an application, pick the Public Products API, copy the two values.\n' +
          'Optionally set KROGER_LOCATION_ID to get prices for a specific store\n' +
          '(find one with: supermarket kroger-stores --zip 90210).'
      );
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.locationId = locationId;

    this.http = axios.create({
      baseURL: API_BASE,
      timeout: 15_000,
      headers: { Accept: 'application/json' },
    });
  }

  /**
   * Application token via client_credentials. Cached until shortly before
   * expiry — Kroger's daily call limit counts token requests too, so
   * re-authenticating per search would waste a meaningful slice of 10,000.
   */
  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) return this.token;

    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    try {
      const { data } = await this.http.post(
        TOKEN_PATH,
        new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }).toString(),
        {
          headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );
      if (!data?.access_token) throw new Error('Kroger returned no access_token');
      this.token = data.access_token as string;
      this.tokenExpiry = Date.now() + (data.expires_in ?? 1800) * 1000 - 60_000;
      return this.token;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) {
        throw new Error(
          'Kroger rejected the credentials (HTTP 401). Check KROGER_CLIENT_ID and ' +
            'KROGER_CLIENT_SECRET, and that your application has the Public Products API enabled.'
        );
      }
      throw new Error(`Kroger auth failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    }
  }

  private toProduct(p: KrogerProduct): Product {
    // A product carries one entry per sellable item; the first is the default.
    const item = p.items?.[0];
    // Promo price is 0 when there is no promotion, so treat 0 as "no promo".
    const promo = item?.price?.promo;
    const price = promo && promo > 0 ? promo : item?.price?.regular ?? 0;

    const images = p.images?.[0]?.sizes ?? [];
    const image =
      images.find(s => s.size === 'large')?.url ?? images[images.length - 1]?.url;

    return {
      // The UPC is the barcode, which makes Open Food Facts enrichment exact
      // rather than a name guess — worth preferring over the internal id.
      product_uid: p.upc || p.productId,
      name: [p.brand, p.description].filter(Boolean).join(' ').trim() || p.description || '(unnamed)',
      retail_price: { price },
      in_stock: (item?.inventory?.stockLevel ?? 'HIGH') !== 'TEMPORARILY_OUT_OF_STOCK',
      image_url: image,
      provider: this.name,
      currency: 'USD',
      size: item?.size,
    };
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const token = await this.ensureToken();
    const limit = options.limit ?? 10;

    const params: Record<string, string | number> = {
      'filter.term': query,
      'filter.limit': Math.min(limit, 50),
    };
    if (options.offset) params['filter.start'] = options.offset;
    // Without a location the API returns catalogue entries with no pricing.
    if (this.locationId) params['filter.locationId'] = this.locationId;

    try {
      const { data } = await this.http.get<{ data?: KrogerProduct[] }>(PRODUCTS_PATH, {
        params,
        headers: { Authorization: `Bearer ${token}` },
      });
      return (data.data ?? []).slice(0, limit).map(p => this.toProduct(p));
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        this.token = undefined;
        this.tokenExpiry = 0;
      }
      if (status === 429) {
        throw new Error(
          'Kroger daily rate limit reached (10,000 calls). Resets at midnight Eastern.'
        );
      }
      throw new Error(`Kroger search failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    }
  }

  async getProduct(productId: string): Promise<Product> {
    const token = await this.ensureToken();
    const params: Record<string, string> = { 'filter.productId': productId };
    if (this.locationId) params['filter.locationId'] = this.locationId;

    const { data } = await this.http.get<{ data?: KrogerProduct[] }>(PRODUCTS_PATH, {
      params,
      headers: { Authorization: `Bearer ${token}` },
    });
    const first = data.data?.[0];
    if (!first) throw new Error(`Kroger: no product with id ${productId}`);
    return this.toProduct(first);
  }

  /**
   * Find store ids near a postcode. Prices are per-store, so this is how you get
   * a usable KROGER_LOCATION_ID — surfaced because the alternative is telling
   * people to go and read the API reference.
   */
  async findStores(zipCode: string, limit = 5): Promise<
    Array<{ locationId: string; name: string; chain: string; address: string }>
  > {
    const token = await this.ensureToken();
    const { data } = await this.http.get<{ data?: any[] }>(LOCATIONS_PATH, {
      params: { 'filter.zipCode.near': zipCode, 'filter.limit': limit },
      headers: { Authorization: `Bearer ${token}` },
    });
    return (data.data ?? []).map(l => ({
      locationId: l.locationId,
      name: l.name,
      chain: l.chain,
      address: [l.address?.addressLine1, l.address?.city, l.address?.state]
        .filter(Boolean)
        .join(', '),
    }));
  }
}
