/**
 * Per-merchant tracking: every merchant connects THEIR OWN courier account; /v1/track uses only the caller's
 * credentials, and merchants can never see each other's accounts, cache entries or shipments.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = require('../../src/app.module');

const courierCalls: { url: string; headers?: any; params?: any }[] = [];
// Each merchant's PostEx token only "owns" its own parcels, like the real per-merchant APIs.
const parcels: Record<string, Record<string, any>> = {
  'TOKEN-A': { 'CX-1': 'Out For Delivery', 'CX-DONE': 'Delivered' },
  'TOKEN-B': { 'CX-B1': 'Delivered' },
};

describe('per-merchant tracking and isolation', () => {
  let app: INestApplication;
  let base: string;
  let db: PrismaClient;
  let keyA: string;
  let keyB: string;
  let keyNone: string;

  const call = async (method: string, path: string, body?: any, k?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (k) headers['x-api-key'] = k;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const mkTenant = async (name: string) => {
    const t = await fetch(base + '/v1/admin/tenants', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': 'admin-test-key' }, body: JSON.stringify({ name }) });
    return (await t.json()).apiKey as string;
  };

  beforeAll(async () => {
    jest.spyOn(CourierHttp.prototype, 'request').mockImplementation(async function (this: any, cfg: any) {
      // account credentials travel as default headers on the per-account axios instance
      const headers = { ...(this?.ax?.defaults?.headers ?? {}), ...(cfg.headers ?? {}) };
      courierCalls.push({ url: cfg.url, headers, params: cfg.params });
      const u: string = cfg.url;
      if (u.startsWith('/v1/track-order/')) {
        const tn = u.split('/').pop()!;
        const status = parcels[headers.token]?.[tn];
        return { status: 200, data: status ? { statusCode: '200', dist: { trackingNumber: tn, transactionStatus: status, transactionStatusHistory: [{ transactionStatusMessage: status, modifiedDatetime: '2026-11-05 09:00:00' }] } } : { statusCode: '400', statusMessage: 'No order found' }, headers: {} } as any;
      }
      if (u.startsWith('/v2/get-operational-city') || u.includes('get-operational-city')) {
        return { status: 200, data: { statusCode: '200', dist: [{ operationalCityName: 'Lahore' }] }, headers: {} } as any;
      }
      if (u.startsWith('trackBookedPacket')) {
        const nums: string[] = String(cfg.params.track_numbers).split(',');
        return { status: 200, headers: {}, data: { status: 1, packet_list: nums.filter((n) => n === 'LE1111111111').map((n) => ({ track_number: n, booked_packet_status: 'Delivered', 'Tracking Detail': [{ Status: 'Delivered', Activity_Date: '2026-11-05', Activity_Time: '02:00 PM' }] })) } } as any;
      }
      if (u.startsWith('getAllCities')) return { status: 200, headers: {}, data: { status: 1, city_list: [{ id: 1, name: 'Lahore' }] } } as any;
      return { status: 404, data: {}, headers: {} } as any;
    });

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    db = new PrismaClient();
    await db.$executeRawUnsafe('TRUNCATE "ShipmentEvent","Shipment","CourierAccount","Tenant","UnmappedStatus" CASCADE');
    keyA = await mkTenant('Merchant A');
    keyB = await mkTenant('Merchant B');
    keyNone = await mkTenant('Merchant With No Accounts');
    expect((await call('POST', '/v1/accounts', { courier: 'POSTEX', credentials: { token: 'TOKEN-A' }, verify: false }, keyA)).status).toBe(201);
    expect((await call('POST', '/v1/accounts', { courier: 'POSTEX', credentials: { token: 'TOKEN-B' }, verify: false }, keyB)).status).toBe(201);
    expect((await call('POST', '/v1/accounts', { courier: 'LEOPARDS', credentials: { apiKey: 'k', apiPassword: 'p' }, verify: false }, keyA)).status).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    jest.restoreAllMocks();
  });

  it('requires an api key', async () => {
    expect((await call('GET', '/v1/track/postex/CX-1')).status).toBe(401);
  });

  it('lists only the couriers the calling merchant connected', async () => {
    const a = await call('GET', '/v1/track', undefined, keyA);
    expect(a.json.connected.map((c: any) => c.courier).sort()).toEqual(['LEOPARDS', 'POSTEX']);
    const b = await call('GET', '/v1/track', undefined, keyB);
    expect(b.json.connected.map((c: any) => c.courier)).toEqual(['POSTEX']);
    expect((await call('GET', '/v1/track', undefined, keyNone)).json.connected).toEqual([]);
  });

  it("uses the caller's own token, not another merchant's", async () => {
    const before = courierCalls.length;
    const r = await call('GET', '/v1/track/postex/CX-1', undefined, keyA);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ courier: 'POSTEX', found: true, status: 'OUT_FOR_DELIVERY', cached: false });
    expect(courierCalls[before].headers.token).toBe('TOKEN-A');
  });

  it("merchant B cannot read merchant A's parcel (courier answers not-found for B's token) and cache does not leak", async () => {
    const r = await call('GET', '/v1/track/postex/CX-1', undefined, keyB);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ found: false });
    expect(r.json.cached).toBe(false);
    const own = await call('GET', '/v1/track/postex/CX-B1', undefined, keyB);
    expect(own.json).toMatchObject({ found: true, status: 'DELIVERED' });
  });

  it('serves repeat lookups for the same merchant from cache', async () => {
    const before = courierCalls.length;
    const r = await call('GET', '/v1/track/postex/CX-1', undefined, keyA);
    expect(r.json.cached).toBe(true);
    expect(courierCalls.length).toBe(before);
  });

  it('does not cache unknown tracking numbers', async () => {
    await call('GET', '/v1/track/postex/CX-NOPE', undefined, keyA);
    const before = courierCalls.length;
    await call('GET', '/v1/track/postex/CX-NOPE', undefined, keyA);
    expect(courierCalls.length).toBe(before + 1);
  });

  it('tells a merchant with no account to connect one (404)', async () => {
    const r = await call('GET', '/v1/track/postex/CX-1', undefined, keyNone);
    expect(r.status).toBe(404);
    expect(r.json.message).toMatch(/No active POSTEX account connected/);
  });

  it('validates input', async () => {
    expect((await call('GET', '/v1/track/fedex/123456', undefined, keyA)).status).toBe(400);
    expect((await call('GET', '/v1/track/postex/a', undefined, keyA)).status).toBe(400);
    expect((await call('GET', '/v1/track/postex/' + encodeURIComponent("x'; DROP TABLE"), undefined, keyA)).status).toBe(400);
  });

  it('bulk: mixed couriers, keeps order, dedupes, isolates per-item failures', async () => {
    const before = courierCalls.filter((c) => c.url.startsWith('trackBookedPacket')).length;
    const r = await call(
      'POST',
      '/v1/track/bulk',
      {
        items: [
          { courier: 'leopards', trackingNumber: 'LE1111111111' },
          { courier: 'postex', trackingNumber: 'CX-DONE' },
          { courier: 'tcs', trackingNumber: '779412326902' }, // merchant A has no TCS account
          { courier: 'leopards', trackingNumber: 'LE1111111111' }, // duplicate
          { courier: 'postex', trackingNumber: '!!' }, // invalid
        ],
      },
      keyA,
    );
    expect(r.status).toBe(201);
    const res = r.json.results;
    expect(res[0]).toMatchObject({ courier: 'LEOPARDS', status: 'DELIVERED' });
    expect(res[1]).toMatchObject({ courier: 'POSTEX', status: 'DELIVERED' });
    expect(res[2].error).toMatch(/No active TCS account/);
    expect(res[3]).toMatchObject({ courier: 'LEOPARDS', status: 'DELIVERED' });
    expect(res[4].error).toMatch(/Invalid tracking number/);
    const leopardsCalls = courierCalls.filter((c) => c.url.startsWith('trackBookedPacket')).slice(before);
    expect(leopardsCalls).toHaveLength(1);
  });

  it("merchants cannot see or use each other's accounts", async () => {
    const accsA = (await call('GET', '/v1/accounts', undefined, keyA)).json;
    const idA = accsA.find((x: any) => x.courier === 'POSTEX').id;
    const listB = (await call('GET', '/v1/accounts', undefined, keyB)).json;
    expect(listB.map((x: any) => x.id)).not.toContain(idA);
    expect((await call('POST', `/v1/accounts/${idA}/verify`, {}, keyB)).status).toBe(404);
    expect((await call('GET', `/v1/track/postex/CX-1?accountId=${idA}`, undefined, keyB)).status).toBe(404);
    expect((await call('DELETE', `/v1/accounts/${idA}`, undefined, keyB)).status).toBe(404);
    // credentials are never returned
    expect(JSON.stringify(accsA)).not.toMatch(/TOKEN-A/);
  });

  it('stores credentials encrypted and keeps tracking lookups out of the shipments table', async () => {
    const rows = await db.courierAccount.findMany();
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.credentialsEnc).not.toMatch(/TOKEN-/);
    expect(await db.shipment.count()).toBe(0);
  });

  it('the same tracking number can exist for two merchants without collision or leakage', async () => {
    const a = await db.tenant.findFirst({ where: { name: 'Merchant A' } });
    const b = await db.tenant.findFirst({ where: { name: 'Merchant B' } });
    const accA = await db.courierAccount.findFirst({ where: { tenantId: a!.id, courier: 'POSTEX' } });
    const accB = await db.courierAccount.findFirst({ where: { tenantId: b!.id, courier: 'POSTEX' } });
    await db.shipment.create({ data: { tenantId: a!.id, accountId: accA!.id, courier: 'POSTEX', trackingNumber: 'DUP-1' } });
    await db.shipment.create({ data: { tenantId: b!.id, accountId: accB!.id, courier: 'POSTEX', trackingNumber: 'DUP-1' } });
    const listA = await call('GET', '/v1/shipments', undefined, keyA);
    const listB = await call('GET', '/v1/shipments', undefined, keyB);
    expect(JSON.stringify(listA.json)).toMatch(/DUP-1/);
    expect(JSON.stringify(listB.json)).toMatch(/DUP-1/);
    const rawA = JSON.stringify(listA.json);
    expect((rawA.match(/DUP-1/g) || []).length).toBe(1);
  });
});
