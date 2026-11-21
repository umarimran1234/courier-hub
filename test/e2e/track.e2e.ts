/**
 * Tenant-less tracking: merchants connect NO courier account; the platform's own credentials are used.
 * Real Postgres + Redis; courier HTTP stubbed.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { PrismaClient } from '@prisma/client';
import { CourierHttp } from '../../src/couriers/http-client';

process.env.ADMIN_KEY = 'admin-test-key';
process.env.ENCRYPTION_KEY = 'c'.repeat(64);
process.env.SYNC_ENABLED = 'false';
process.env.TRACK_CACHE_SECONDS = '60';
// TCS deliberately NOT configured, to test the 503 path. Leopards entry is incomplete -> disabled.
process.env.PLATFORM_COURIERS = JSON.stringify({ POSTEX: { token: 'PLATFORM-TOKEN' }, LEOPARDS: { apiKey: 'k', apiPassword: 'p' } });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = require('../../src/app.module');

const courierCalls: { url: string; headers?: any; params?: any }[] = [];
const postex: Record<string, any> = {
  'CX-1': { transactionStatus: 'Out For Delivery', transactionStatusHistory: [{ transactionStatusMessage: 'Out For Delivery', modifiedDatetime: '2026-11-05 09:00:00' }] },
  'CX-DONE': { transactionStatus: 'Delivered', transactionStatusHistory: [{ transactionStatusMessage: 'Delivered', modifiedDatetime: '2026-11-05 15:00:00' }] },
};

describe('platform-credential tracking (no merchant accounts)', () => {
  let app: INestApplication;
  let base: string;
  let db: PrismaClient;
  let key: string;

  const call = async (method: string, path: string, body?: any, k: string | undefined = key) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (k) headers['x-api-key'] = k;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  beforeAll(async () => {
    jest.spyOn(CourierHttp.prototype, 'request').mockImplementation(async (cfg: any) => {
      courierCalls.push({ url: cfg.url, headers: cfg.headers, params: cfg.params });
      const u: string = cfg.url;
      if (u.startsWith('/v1/track-order/')) {
        const tn = u.split('/').pop()!;
        return { status: 200, data: postex[tn] ? { statusCode: '200', dist: { trackingNumber: tn, ...postex[tn] } } : { statusCode: '400', statusMessage: 'No order found' }, headers: {} } as any;
      }
      if (u.startsWith('trackBookedPacket')) {
        const nums: string[] = String(cfg.params.track_numbers).split(',');
        return { status: 200, headers: {}, data: { status: 1, packet_list: nums.filter((n) => n === 'LE1111111111').map((n) => ({ track_number: n, booked_packet_status: 'Delivered', 'Tracking Detail': [{ Status: 'Delivered', Activity_Date: '2026-11-05', Activity_Time: '02:00 PM' }] })) } } as any;
      }
      return { status: 404, data: {}, headers: {} } as any;
    });

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    db = new PrismaClient();
    await db.$executeRawUnsafe('TRUNCATE "ShipmentEvent","Shipment","CourierAccount","Tenant","UnmappedStatus" CASCADE');
    const t = await fetch(base + '/v1/admin/tenants', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': 'admin-test-key' }, body: JSON.stringify({ name: 'Merchant With No Courier Account' }) });
    key = (await t.json()).apiKey;
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    jest.restoreAllMocks();
  });

  it('requires an api key', async () => {
    expect((await call('GET', '/v1/track/postex/CX-1', undefined, '')).status).toBe(401);
  });

  it('lists which couriers the platform has credentials for', async () => {
    const r = await call('GET', '/v1/track');
    expect(r.json.configured.sort()).toEqual(['LEOPARDS', 'POSTEX']);
  });

  it('returns status for a tenant that connected no courier account, using the platform token', async () => {
    const before = courierCalls.length;
    const r = await call('GET', '/v1/track/postex/CX-1');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ courier: 'POSTEX', found: true, status: 'OUT_FOR_DELIVERY', cached: false });
    expect(courierCalls.length).toBe(before + 1);
  });

  it('serves repeat lookups from cache (no second courier call)', async () => {
    const before = courierCalls.length;
    const r = await call('GET', '/v1/track/postex/CX-1');
    expect(r.json.cached).toBe(true);
    expect(courierCalls.length).toBe(before);
  });

  it('reports unknown tracking numbers as found=false (and does not cache them)', async () => {
    const a = await call('GET', '/v1/track/postex/CX-NOPE');
    expect(a.json).toMatchObject({ found: false });
    const before = courierCalls.length;
    await call('GET', '/v1/track/postex/CX-NOPE');
    expect(courierCalls.length).toBe(before + 1);
  });

  it('answers 503 for a courier that is not configured', async () => {
    const r = await call('GET', '/v1/track/tcs/779412326902');
    expect(r.status).toBe(503);
    expect(r.json.message).toMatch(/TCS tracking is not configured/);
  });

  it('validates input', async () => {
    expect((await call('GET', '/v1/track/fedex/123456')).status).toBe(400);
    expect((await call('GET', '/v1/track/postex/a')).status).toBe(400);
    expect((await call('GET', '/v1/track/postex/' + encodeURIComponent("x'; DROP TABLE"))).status).toBe(400);
  });

  it('bulk: mixed couriers, keeps order, dedupes, isolates per-item failures', async () => {
    const before = courierCalls.filter((c) => c.url.startsWith('trackBookedPacket')).length;
    const r = await call('POST', '/v1/track/bulk', {
      items: [
        { courier: 'leopards', trackingNumber: 'LE1111111111' },
        { courier: 'postex', trackingNumber: 'CX-DONE' },
        { courier: 'tcs', trackingNumber: '779412326902' }, // not configured
        { courier: 'leopards', trackingNumber: 'LE1111111111' }, // duplicate
        { courier: 'postex', trackingNumber: '!!' }, // invalid
      ],
    });
    expect(r.status).toBe(201);
    const res = r.json.results;
    expect(res[0]).toMatchObject({ courier: 'LEOPARDS', status: 'DELIVERED' });
    expect(res[1]).toMatchObject({ courier: 'POSTEX', status: 'DELIVERED' });
    expect(res[2].error).toMatch(/not configured/);
    expect(res[3]).toMatchObject({ courier: 'LEOPARDS', status: 'DELIVERED' });
    expect(res[4].error).toMatch(/Invalid tracking number/);
    const leopardsCalls = courierCalls.filter((c) => c.url.startsWith('trackBookedPacket')).slice(before);
    expect(leopardsCalls).toHaveLength(1);
    expect(leopardsCalls[0].params.track_numbers).toBe('LE1111111111');
  });

  it('stores nothing in the database', async () => {
    expect(await db.shipment.count()).toBe(0);
    expect(await db.courierAccount.count()).toBe(0);
  });
});
