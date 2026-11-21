/**
 * End-to-end test against a REAL Postgres + Redis (set DATABASE_URL and REDIS_URL).
 * Courier HTTP calls are stubbed; everything else (Nest DI, guards, DTO validation, Prisma, BullMQ) is real.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { createHmac } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { CourierHttp } from '../../src/couriers/http-client';
import { SyncProcessor } from '../../src/sync/sync.service';

process.env.ADMIN_KEY = 'admin-test-key';
process.env.ENCRYPTION_KEY = 'b'.repeat(64);
process.env.SYNC_ENABLED = 'false';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = require('../../src/app.module');

type R = { status?: number; data: any; headers?: any };
const state = {
  n: 0,
  ln: 0,
  postex: {} as Record<string, { status: string; history: any[] }>,
  leopards: {} as Record<string, string>,
};

function courierRouter(cfg: any): R {
  const u: string = cfg.url;
  // ---- PostEx
  if (u === '/v2/get-operational-city') return { data: { statusCode: '200', dist: [{ operationalCityName: 'Lahore' }, { operationalCityName: 'Karachi' }] } };
  if (u === '/v3/create-order') {
    const tn = `CX-${1000 + ++state.n}`;
    state.postex[tn] = { status: 'Booked', history: [] };
    return { data: { statusCode: '200', statusMessage: 'OK', dist: { trackingNumber: tn } } };
  }
  if (u.startsWith('/v1/track-order/')) {
    const tn = decodeURIComponent(u.split('/').pop()!);
    const s = state.postex[tn];
    if (!s) return { data: { statusCode: '400', statusMessage: 'No order found' } };
    return { data: { statusCode: '200', dist: { trackingNumber: tn, transactionStatus: s.status, transactionStatusHistory: s.history } } };
  }
  if (u === '/v1/cancel-order') return { data: { statusCode: '200', statusMessage: 'Order cancelled' } };
  // ---- Leopards
  if (u.startsWith('getAllCities')) return { data: { status: 1, city_list: [{ id: '789', name: 'Lahore' }] } };
  if (u.startsWith('bookPacket')) {
    const tn = `LE${String(2000000000 + ++state.ln)}`;
    state.leopards[tn] = 'Pickup request not send';
    return { data: { status: 1, track_number: tn, slip_link: `https://leopards.test/slip/${tn}` } };
  }
  if (u.startsWith('trackBookedPacket')) {
    const nums: string[] = String(cfg.params.track_numbers).split(',');
    return {
      data: {
        status: 1,
        packet_list: nums.filter((x) => state.leopards[x]).map((x) => ({ track_number: x, booked_packet_status: state.leopards[x], 'Tracking Detail': [{ Status: state.leopards[x], Activity_Date: '2026-11-05', Activity_Time: '09:00 AM' }] })),
      },
    };
  }
  return { status: 404, data: { message: `unrouted ${u}` } };
}

describe('courier-hub e2e', () => {
  let app: INestApplication;
  let base: string;
  let db: PrismaClient;
  let hook: Server;
  const hookReceived: { sig?: string; body: string }[] = [];
  let hookUrl: string;

  const call = async (method: string, path: string, opts: { key?: string; admin?: boolean; body?: any } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.key) headers['x-api-key'] = opts.key;
    if (opts.admin) headers['x-admin-key'] = 'admin-test-key';
    const res = await fetch(base + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined, redirect: 'manual' });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };

  beforeAll(async () => {
    jest.spyOn(CourierHttp.prototype, 'request').mockImplementation(async (cfg: any) => {
      const r = courierRouter(cfg);
      return { status: r.status ?? 200, data: r.data, headers: r.headers ?? {} } as any;
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    db = new PrismaClient();
    // fresh slate: the mocked couriers reuse tracking numbers between runs
    await db.$executeRawUnsafe('TRUNCATE "ShipmentEvent","Shipment","CourierAccount","Tenant","UnmappedStatus" CASCADE');

    hook = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        hookReceived.push({ sig: req.headers['x-courierhub-signature'] as string, body: b });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    hook?.close();
    jest.restoreAllMocks();
  });

  let keyA: string;
  let keyB: string;
  let hookSecret: string;
  let postexShipmentId: string;
  let postexTn: string;

  it('rejects calls without credentials', async () => {
    expect((await call('GET', '/v1/shipments')).status).toBe(401);
    expect((await call('GET', '/v1/shipments', { key: 'chk_wrong' })).status).toBe(401);
    expect((await call('POST', '/v1/admin/tenants', { body: { name: 'x' } })).status).toBe(401);
  });

  it('creates tenants (admin) and returns API keys once', async () => {
    const a = await call('POST', '/v1/admin/tenants', { admin: true, body: { name: 'Store A', webhookUrl: hookUrl } });
    expect(a.status).toBe(201);
    expect(a.json.apiKey).toMatch(/^chk_/);
    keyA = a.json.apiKey;
    hookSecret = a.json.webhookSecret;
    const b = await call('POST', '/v1/admin/tenants', { admin: true, body: { name: 'Store B' } });
    keyB = b.json.apiKey;
    expect((await call('GET', '/v1/tenant', { key: keyA })).json.name).toBe('Store A');
  });

  it('lists supported couriers and capability flags', async () => {
    const r = await call('GET', '/v1/couriers', { key: keyA });
    expect(r.json.map((c: any) => c.courier).sort()).toEqual(['LEOPARDS', 'POSTEX', 'TCS']);
    expect(r.json.find((c: any) => c.courier === 'LEOPARDS').capabilities.cancel.verified).toBe(false);
  });

  it('validates credentials fields and stores them encrypted', async () => {
    const bad = await call('POST', '/v1/accounts', { key: keyA, body: { courier: 'tcs', credentials: { username: 'u' } } });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/Missing credential fields for TCS/);

    const ok = await call('POST', '/v1/accounts', { key: keyA, body: { courier: 'postex', credentials: { token: 'SUPER-SECRET-TOKEN', pickupAddressCode: '001' } } });
    expect(ok.status).toBe(201);
    expect(JSON.stringify(ok.json)).not.toContain('SUPER-SECRET-TOKEN');
    const row = await db.courierAccount.findUnique({ where: { id: ok.json.id } });
    expect(row!.credentialsEnc).not.toContain('SUPER-SECRET-TOKEN');

    const dup = await call('POST', '/v1/accounts', { key: keyA, body: { courier: 'postex', credentials: { token: 'x' } } });
    expect(dup.status).toBe(409);

    const lp = await call('POST', '/v1/accounts', { key: keyA, body: { courier: 'LEOPARDS', credentials: { apiKey: 'k', apiPassword: 'p' } } });
    expect(lp.status).toBe(201);
  });

  it('books a PostEx shipment, rejects invalid payloads and duplicate order refs', async () => {
    const invalid = await call('POST', '/v1/shipments', { key: keyA, body: { courier: 'postex', orderRef: '#1', codAmount: -5 } });
    expect(invalid.status).toBe(400);

    const body = { courier: 'postex', orderRef: '#1001', codAmount: 2500, weightKg: 1, pieces: 1, consignee: { name: 'Ali Khan', phone: '03001234567', address: 'House 1, Street 2', city: 'Lahore' } };
    const r = await call('POST', '/v1/shipments', { key: keyA, body });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ courier: 'POSTEX', status: 'CREATED', orderRef: '#1001' });
    expect(r.json.bookingRaw).toBeUndefined();
    postexShipmentId = r.json.id;
    postexTn = r.json.trackingNumber;

    const dup = await call('POST', '/v1/shipments', { key: keyA, body });
    expect(dup.status).toBe(409);
    expect(dup.json.trackingNumber).toBe(postexTn);
  });

  it('tracks by courier + tracking number and persists history + delivered state', async () => {
    state.postex[postexTn] = {
      status: 'Delivered',
      history: [
        { transactionStatusMessage: 'Order Booked', modifiedDatetime: '2026-11-01 10:00:00' },
        { transactionStatusMessage: 'Out For Delivery', modifiedDatetime: '2026-11-03 09:00:00' },
        { transactionStatusMessage: 'Delivered', modifiedDatetime: '2026-11-03 15:00:00' },
      ],
    };
    const r = await call('GET', `/v1/shipments/track/postex/${postexTn}`, { key: keyA });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ stored: true, status: 'DELIVERED', isTerminal: true });
    expect(r.json.events.length).toBeGreaterThanOrEqual(3);
    expect(r.json.deliveredAt).toBe('2026-11-03T10:00:00.000Z');
  });

  it('keeps a delivered shipment final even if the courier later reports something else', async () => {
    state.postex[postexTn].status = 'Out For Delivery';
    const r = await call('POST', `/v1/shipments/${postexShipmentId}/refresh`, { key: keyA });
    expect(r.json.status).toBe('DELIVERED');
  });

  it('tracks a shipment that was not booked via the platform (not stored)', async () => {
    state.postex['CX-EXTERNAL'] = { status: 'Out For Delivery', history: [] };
    const r = await call('GET', '/v1/shipments/track/postex/CX-EXTERNAL', { key: keyA });
    expect(r.json).toMatchObject({ stored: false, found: true, status: 'OUT_FOR_DELIVERY' });
    const missing = await call('GET', '/v1/shipments/track/postex/NOPE', { key: keyA });
    expect(missing.json).toMatchObject({ found: false });
  });

  it('records statuses it cannot classify, without regressing shipment state', async () => {
    const b = await call('POST', '/v1/shipments', { key: keyA, body: { courier: 'postex', orderRef: '#1002', codAmount: 0, consignee: { name: 'Sara Ahmed', phone: '03111234567', address: 'Flat 4, Block C', city: 'Karachi' } } });
    const tn = b.json.trackingNumber;
    state.postex[tn].status = 'Zorbulating quantumly';
    const r = await call('GET', `/v1/shipments/track/postex/${tn}`, { key: keyA });
    expect(r.json.status).toBe('CREATED'); // UNKNOWN never overwrites
    expect(r.json.rawStatus).toBe('Zorbulating quantumly');
    const un = await call('GET', '/v1/admin/unmapped-statuses', { admin: true });
    expect(un.json.some((u: any) => u.rawStatus === 'Zorbulating quantumly' && u.courier === 'POSTEX')).toBe(true);
  });

  it('bulk tracks across couriers in one call', async () => {
    const lb = await call('POST', '/v1/shipments', { key: keyA, body: { courier: 'leopards', orderRef: '#2001', codAmount: 1500, consignee: { name: 'Bilal', phone: '03211234567', address: 'Model Town Lahore', city: 'Lahore' } } });
    expect(lb.status).toBe(201);
    expect(lb.json.labelUrl).toContain('leopards.test/slip');
    state.leopards[lb.json.trackingNumber] = 'Out for delivery';
    const r = await call('POST', '/v1/shipments/track-bulk', { key: keyA, body: { items: [{ courier: 'leopards', trackingNumber: lb.json.trackingNumber }, { courier: 'postex', trackingNumber: postexTn }, { courier: 'leopards', trackingNumber: 'LE0000000000' }] } });
    expect(r.status).toBe(201);
    expect(r.json.results[0]).toMatchObject({ status: 'OUT_FOR_DELIVERY', stored: true });
    expect(r.json.results[1].status).toBeDefined();
    expect(r.json.results[2].found).toBe(false);
  });

  it('label: redirects to the stored courier slip', async () => {
    const list = await call('GET', '/v1/shipments?courier=leopards', { key: keyA });
    const id = list.json.items[0].id;
    const r = await call('GET', `/v1/shipments/${id}/label`, { key: keyA });
    expect(r.status).toBe(302);
  });

  it('isolates tenants', async () => {
    expect((await call('GET', `/v1/shipments/${postexShipmentId}`, { key: keyB })).status).toBe(404);
    expect((await call('GET', '/v1/shipments', { key: keyB })).json.items).toHaveLength(0);
    expect((await call('GET', `/v1/shipments/track/postex/${postexTn}`, { key: keyB })).status).toBe(404); // B has no PostEx account
  });

  it('cancel: refused when already delivered, works on an open shipment', async () => {
    expect((await call('POST', `/v1/shipments/${postexShipmentId}/cancel`, { key: keyA })).status).toBe(400);
    const b = await call('POST', '/v1/shipments', { key: keyA, body: { courier: 'postex', orderRef: '#1003', codAmount: 100, consignee: { name: 'Zed Z', phone: '03001230000', address: 'Somewhere 12', city: 'Lahore' } } });
    const c = await call('POST', `/v1/shipments/${b.json.id}/cancel`, { key: keyA });
    expect(c.status).toBe(201);
    expect(c.json.shipment.status).toBe('CANCELLED');
    // re-booking the cancelled order ref is allowed
    const again = await call('POST', '/v1/shipments', { key: keyA, body: { courier: 'postex', orderRef: '#1003', codAmount: 100, consignee: { name: 'Zed Z', phone: '03001230000', address: 'Somewhere 12', city: 'Lahore' } } });
    expect(again.status).toBe(201);
  });

  it('accepts Leopards push updates on the per-account token URL', async () => {
    const accs = await call('GET', '/v1/accounts', { key: keyA });
    const lp = accs.json.find((a: any) => a.courier === 'LEOPARDS');
    const b = await call('POST', '/v1/shipments', { key: keyA, body: { courier: 'leopards', orderRef: '#2002', codAmount: 500, consignee: { name: 'Hina', phone: '03331234567', address: 'DHA Phase 5', city: 'Lahore' } } });
    const bad = await call('POST', `/v1/webhooks/leopards/not-a-token`, { body: { track_number: b.json.trackingNumber, status: 'Delivered' } });
    expect(bad.status).toBe(404);
    const ok = await call('POST', `/v1/webhooks/leopards/${lp.webhookToken}`, { body: { track_number: b.json.trackingNumber, status: 'Delivered', date: '2026-11-06', time: '01:00 PM' } });
    expect(ok.status).toBe(200);
    expect(ok.json.applied).toBe(1);
    const s = await call('GET', `/v1/shipments/${b.json.id}`, { key: keyA });
    expect(s.json).toMatchObject({ status: 'DELIVERED', isTerminal: true });
  });

  it('sends HMAC-signed outbound webhooks to the tenant on status changes', async () => {
    const delivered = hookReceived.filter((h) => JSON.parse(h.body).shipment?.status === 'DELIVERED');
    // wait for the BullMQ worker to deliver
    for (let i = 0; i < 40 && delivered.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
      delivered.push(...hookReceived.filter((h) => JSON.parse(h.body).shipment?.status === 'DELIVERED'));
    }
    expect(delivered.length).toBeGreaterThan(0);
    const h = delivered[0];
    expect(h.sig).toBe(createHmac('sha256', hookSecret).update(h.body).digest('hex'));
    expect(JSON.parse(h.body)).toMatchObject({ event: 'shipment.status_changed' });
  });

  it('background sync picks up open shipments and updates them', async () => {
    const b = await call('POST', '/v1/shipments', { key: keyA, body: { courier: 'leopards', orderRef: '#2003', codAmount: 700, consignee: { name: 'Omar', phone: '03451234567', address: 'Gulberg III', city: 'Lahore' } } });
    state.leopards[b.json.trackingNumber] = 'Out for delivery';

    const proc = app.get(SyncProcessor);
    const res: any = await proc.process({ name: 'scan', data: {} } as any);
    expect(res.accounts).toBeGreaterThan(0);

    let status = 'CREATED';
    for (let i = 0; i < 40 && status === 'CREATED'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      status = (await call('GET', `/v1/shipments/${b.json.id}`, { key: keyA })).json.status;
    }
    expect(status).toBe('OUT_FOR_DELIVERY');
  });

  it('filters and paginates the shipment list', async () => {
    const page1 = await call('GET', '/v1/shipments?limit=2', { key: keyA });
    expect(page1.json.items).toHaveLength(2);
    expect(page1.json.nextCursor).toBeTruthy();
    const page2 = await call('GET', `/v1/shipments?limit=2&cursor=${page1.json.nextCursor}`, { key: keyA });
    expect(page2.json.items[0].id).not.toBe(page1.json.items[0].id);
    expect((await call('GET', '/v1/shipments?status=DELIVERED', { key: keyA })).json.items.every((s: any) => s.status === 'DELIVERED')).toBe(true);
    expect((await call('GET', '/v1/shipments?status=NOPE', { key: keyA })).status).toBe(400);
    expect((await call('GET', '/v1/shipments?orderRef=%231001', { key: keyA })).json.items).toHaveLength(1);
  });

  it('refuses to delete an account that still has shipments in progress', async () => {
    const accs = await call('GET', '/v1/accounts', { key: keyA });
    const lp = accs.json.find((a: any) => a.courier === 'LEOPARDS');
    expect((await call('DELETE', `/v1/accounts/${lp.id}`, { key: keyA })).status).toBe(409);
  });
});
