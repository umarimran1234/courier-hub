import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Courier } from '@prisma/client';
import { AccountContext } from '../couriers/courier.types';

/** Minimum credentials each courier needs for TRACKING only (booking needs more). */
const TRACKING_REQUIRED: Record<Courier, string[]> = {
  POSTEX: ['token'],
  LEOPARDS: ['apiKey', 'apiPassword'],
  TCS: ['username', 'password'], // clientId + clientSecret are optional but recommended (tracking API bearer)
};

/**
 * The platform's OWN courier credentials, read from env `PLATFORM_COURIERS` (JSON):
 *   {"POSTEX":{"token":"..."},
 *    "LEOPARDS":{"apiKey":"...","apiPassword":"..."},
 *    "TCS":{"username":"...","password":"...","clientId":"...","clientSecret":"...","sandbox":false}}
 * Used by /v1/track/* so merchants never have to connect a courier account.
 */
@Injectable()
export class PlatformAccountsService {
  private log = new Logger('PlatformAccounts');
  private creds: Partial<Record<Courier, Record<string, any>>> = {};

  constructor(cfg: ConfigService) {
    const raw = cfg.get<string>('PLATFORM_COURIERS');
    if (!raw) {
      this.log.warn('PLATFORM_COURIERS is not set: /v1/track/* will answer 503 until courier credentials are configured');
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      for (const [k, v] of Object.entries(parsed)) {
        const courier = k.toUpperCase() as Courier;
        if (!(courier in TRACKING_REQUIRED)) {
          this.log.warn(`PLATFORM_COURIERS: unknown courier "${k}" ignored`);
          continue;
        }
        const missing = TRACKING_REQUIRED[courier].filter((f) => !(v as any)?.[f]);
        if (missing.length) {
          this.log.warn(`PLATFORM_COURIERS.${courier} is missing ${missing.join(', ')} and will be disabled`);
          continue;
        }
        this.creds[courier] = v as Record<string, any>;
      }
      this.log.log(`Platform tracking enabled for: ${Object.keys(this.creds).join(', ') || 'none'}`);
    } catch (e) {
      this.log.error(`PLATFORM_COURIERS is not valid JSON: ${(e as Error).message}`);
    }
  }

  configured(): Courier[] {
    return Object.keys(this.creds) as Courier[];
  }

  get(courier: Courier): AccountContext {
    const c = this.creds[courier];
    if (!c) throw new ServiceUnavailableException(`${courier} tracking is not configured on this server (set it in PLATFORM_COURIERS)`);
    const { sandbox, ...credentials } = c;
    return { id: `platform-${courier}`, courier, sandbox: !!sandbox, credentials };
  }
}
