/**
 * Albert Heijn (Netherlands) — catalogue search.
 *
 * AH issues an *anonymous* bearer token to anyone who asks, which is why this
 * provider needs no account, no address and no browser. That makes it the
 * reference implementation for a search-only provider: if you want to add your
 * country's supermarket, copy this file.
 *
 * Protocol credit: github.com/gwillem/appie-go (Go, MIT). No code was copied —
 * the endpoints, the `x-application` header and the anonymous token flow were
 * read from that project and reimplemented here.
 *
 * Verified live: 2026-08-03.
 */

import axios, { AxiosInstance } from 'axios';
import type { Product, SearchOptions } from './types';

const API_BASE = 'https://api.ah.nl';
const CLIENT_ID = 'appie-ios';

/**
 * Without this header the API returns HTTP 500
 * "Can not find application: 'null'". It is not optional.
 */
const APPLICATION = 'AHWEBSHOP';

interface AhToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface AhProduct {
  webshopId: number;
  title: string;
  salesUnitSize?: string;
  priceBeforeBonus?: number;
  currentPrice?: number;
  orderable?: boolean;
  images?: Array<{ url: string; width?: number }>;
  brand?: string;
  mainCategory?: string;
}

export class AlbertHeijnProvider {
  readonly name = 'ah';

  private http: AxiosInstance;
  private token?: string;
  private tokenExpiry = 0;

  constructor() {
    this.http = axios.create({
      baseURL: API_BASE,
      timeout: 15_000,
      headers: {
        'x-application': APPLICATION,
        'x-client-name': CLIENT_ID,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Appie/8.22.3',
      },
    });
  }

  /**
   * Anonymous token. Cached until 60s before expiry so a multi-command session
   * does not re-authenticate on every call.
   */
  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) return this.token;

    try {
      const { data } = await this.http.post<AhToken>(
        '/mobile-auth/v1/auth/token/anonymous',
        { clientId: CLIENT_ID }
      );
      if (!data?.access_token) {
        throw new Error('Albert Heijn returned no access_token');
      }
      this.token = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
      return this.token;
    } catch (err: any) {
      const status = err?.response?.status;
      throw new Error(
        `Albert Heijn anonymous auth failed${status ? ` (HTTP ${status})` : ''}. ` +
          `The API may have changed — please open an issue.`
      );
    }
  }

  private toProduct(p: AhProduct): Product {
    const price = p.currentPrice ?? p.priceBeforeBonus ?? 0;
    return {
      product_uid: String(p.webshopId),
      name: p.title,
      retail_price: { price },
      in_stock: p.orderable !== false,
      image_url: p.images?.[p.images.length - 1]?.url,
      provider: this.name,
      currency: 'EUR',
      size: p.salesUnitSize,
    };
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const token = await this.ensureToken();
    const limit = options.limit ?? 10;

    try {
      const { data } = await this.http.get<{ products?: AhProduct[] }>(
        '/mobile-services/product/search/v2',
        {
          params: {
            query,
            size: limit,
            page: Math.floor((options.offset ?? 0) / Math.max(limit, 1)),
            sortOn: 'RELEVANCE',
          },
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      return (data.products ?? []).slice(0, limit).map((p) => this.toProduct(p));
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        // Token rejected mid-session; drop it so the next call re-authenticates.
        this.token = undefined;
        this.tokenExpiry = 0;
      }
      throw new Error(
        `Albert Heijn search failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`
      );
    }
  }

  async getProduct(productId: string): Promise<Product> {
    const token = await this.ensureToken();
    const { data } = await this.http.get<AhProduct[]>(
      '/mobile-services/product/search/v2/products',
      {
        params: { ids: productId, sortOn: 'INPUT_PRODUCT_IDS' },
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const first = Array.isArray(data) ? data[0] : undefined;
    if (!first) throw new Error(`Albert Heijn: no product with id ${productId}`);
    return this.toProduct(first);
  }
}
