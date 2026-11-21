import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Logger } from '@nestjs/common';
import { CourierError } from './courier.errors';

const breakers = new Map<string, { fails: number; openUntil: number }>();
const FAIL_THRESHOLD = 5;
const OPEN_MS = 60_000;

/**
 * Thin axios wrapper used by every adapter:
 *  - 20s timeout
 *  - retries (2x, exponential backoff) on network errors / 5xx / 429
 *  - per-courier circuit breaker (5 consecutive failures -> 60s open)
 *  - GET requests may carry a JSON body (PostEx bulk track and TCS require it)
 */
export class CourierHttp {
  private readonly log: Logger;
  private readonly ax: AxiosInstance;

  constructor(private readonly courier: string, baseURL: string, defaultHeaders: Record<string, string> = {}) {
    this.log = new Logger(`Http:${courier}`);
    this.ax = axios.create({
      baseURL,
      timeout: 20_000,
      headers: defaultHeaders,
      validateStatus: () => true, // we inspect status ourselves
    });
  }

  async request<T = any>(cfg: AxiosRequestConfig, opts: { retries?: number; responseType?: 'json' | 'arraybuffer' } = {}): Promise<{ status: number; data: T; headers: any }> {
    const retries = opts.retries ?? 2;
    const key = this.courier;
    const br = breakers.get(key);
    if (br && br.openUntil > Date.now()) {
      throw new CourierError(this.courier, 'Courier API temporarily unavailable (circuit open), try again shortly', { retriable: true });
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.ax.request<T>({ ...cfg, responseType: opts.responseType ?? 'json' });
        if (res.status >= 500 || res.status === 429) {
          lastErr = new CourierError(this.courier, `HTTP ${res.status}`, { retriable: true, httpStatus: res.status, raw: res.data });
        } else {
          this.recordSuccess(key);
          return { status: res.status, data: res.data, headers: res.headers };
        }
      } catch (e: any) {
        lastErr = new CourierError(this.courier, `Network error: ${e.code || e.message}`, { retriable: true });
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
    this.recordFailure(key);
    this.log.warn(`request failed after retries: ${cfg.method} ${cfg.url}`);
    throw lastErr;
  }

  private recordSuccess(k: string) {
    breakers.delete(k);
  }
  private recordFailure(k: string) {
    const b = breakers.get(k) ?? { fails: 0, openUntil: 0 };
    b.fails += 1;
    if (b.fails >= FAIL_THRESHOLD) {
      b.openUntil = Date.now() + OPEN_MS;
      b.fails = 0;
    }
    breakers.set(k, b);
  }
}

/** Parse a response body that may arrive as a JSON string. */
export function asJson(data: any): any {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}
