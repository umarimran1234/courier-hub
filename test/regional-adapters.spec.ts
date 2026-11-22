import { Courier, ShipmentStatus as S } from '@prisma/client';
import { CourierHttp } from '../src/couriers/http-client';
import { EcourierAdapter } from '../src/couriers/adapters/ecourier.adapter';
import { RedxAdapter } from '../src/couriers/adapters/redx.adapter';
import { PathaoAdapter } from '../src/couriers/adapters/pathao.adapter';
import { BostaAdapter } from '../src/couriers/adapters/bosta.adapter';
import { ShiprocketAdapter } from '../src/couriers/adapters/shiprocket.adapter';
import { TranzoAdapter } from '../src/couriers/adapters/tranzo.adapter';
import { AccountContext } from '../src/couriers/courier.types';
import { NotSupportedError } from '../src/couriers/courier.errors';

type Call = { method?: string; url?: string; data?: any; params?: any; headers?: any; defaults?: any; base?: string };
let calls: Call[] = [];
let handler: (c: Call) => { status?: number; data: any };

beforeEach(() => {
  calls = [];
  jest.spyOn(CourierHttp.prototype, 'request').mockImplementation(async function (this: any, cfg: any) {
    const c = { ...cfg, defaults: this.ax.defaults.headers, base: this.ax.defaults.baseURL };
    calls.push(c);
    const r = handler(c);
    return { status: r.status ?? 200, data: r.data, headers: {} } as any;
  });
});
afterEach(() => jest.restoreAllMocks());

let n = 0;
const ctx = (courier: Courier, credentials: any, sandbox = false): AccountContext => ({ id: `acc-${courier}-${n++}`, courier, sandbox, credentials });

describe('eCourier', () => {
  const a = new EcourierAdapter();
  const c = () => ctx(Courier.ECOURIER, { apiKey: 'k', apiSecret: 's', userId: 'u' });
  it('sends the three auth headers and parses status history', async () => {
    handler = () => ({ data: { response_code: 200, query_data: [{ r_name: 'Rahim', status: [{ status: 'Order Placed', timestamp: '2026-11-01 10:00:00' }, { status: 'Delivered', timestamp: '2026-11-03 15:00:00' }] }] } });
    const r = await a.track(c(), 'ECR123');
    expect(calls[0].url).toBe('/track');
    expect(calls[0].data).toEqual({ ecr: 'ECR123' });
    expect(calls[0].defaults['API-KEY']).toBe('k');
    expect(calls[0].defaults['USER-ID']).toBe('u');
    expect(r.found).toBe(true);
    expect(r.status).toBe(S.DELIVERED);
    expect(r.receiverName).toBe('Rahim');
  });
  it('"No Data Found" -> not found; 401 -> error', async () => {
    handler = () => ({ data: { response_code: 200, query_data: 'No Data Found' } });
    expect((await a.track(c(), 'X')).found).toBe(false);
    handler = () => ({ status: 401, data: {} });
    await expect(a.verifyCredentials(c())).rejects.toThrow(/Unauthorized/);
  });
  it('uses staging host in sandbox; booking unsupported', async () => {
    handler = () => ({ data: { query_data: 'No Data Found' } });
    await a.track(ctx(Courier.ECOURIER, { apiKey: 'k', apiSecret: 's', userId: 'u' }, true), 'X');
    expect(calls[0].base).toBe('https://staging.ecourier.com.bd/api');
    await expect(a.book()).rejects.toBeInstanceOf(NotSupportedError);
  });
});

describe('RedX', () => {
  const a = new RedxAdapter();
  it('adds Bearer prefix once and maps timeline', async () => {
    handler = () => ({ data: { tracking: [{ message_en: 'Parcel received at hub', time: '2026-11-01T10:00:00+06:00' }, { message_en: 'Parcel delivered', time: '2026-11-02T12:00:00+06:00' }] } });
    const r = await a.track(ctx(Courier.REDX, { accessToken: 'abc' }), 'RX1');
    expect(calls[0].url).toBe('/parcel/track/RX1');
    expect(calls[0].defaults['API-ACCESS-TOKEN']).toBe('Bearer abc');
    expect(r.status).toBe(S.DELIVERED);
    await a.track(ctx(Courier.REDX, { accessToken: 'Bearer abc' }), 'RX1');
    expect(calls[1].defaults['API-ACCESS-TOKEN']).toBe('Bearer abc');
  });
  it('404 not found, 401 error', async () => {
    handler = () => ({ status: 404, data: { message: 'not found' } });
    expect((await a.track(ctx(Courier.REDX, { accessToken: 't' }), 'Z')).found).toBe(false);
    handler = () => ({ status: 401, data: {} });
    await expect(a.verifyCredentials(ctx(Courier.REDX, { accessToken: 't' }))).rejects.toThrow(/Unauthorized/);
  });
});

describe('Pathao', () => {
  const a = new PathaoAdapter();
  const c = () => ctx(Courier.PATHAO, { clientId: 'i', clientSecret: 's', username: 'u@x.com', password: 'p' });
  const h = (info: any) => (call: Call) => (call.url!.includes('issue-token') ? { data: { access_token: 'TOK', expires_in: 3600 } } : info);
  it('issues token (password grant) then reads order info', async () => {
    handler = h({ data: { data: { consignment_id: 'DL1', order_status: 'Delivered', order_status_slug: 'Delivered', updated_at: '2026-11-05 12:00:00' } } });
    const acc = c();
    const r = await a.track(acc, 'DL1');
    expect(calls[0].data).toMatchObject({ grant_type: 'password', client_id: 'i', username: 'u@x.com' });
    expect(calls[1].url).toBe('/aladdin/api/v1/orders/DL1/info');
    expect(calls[1].defaults.Authorization).toBe('Bearer TOK');
    expect(r.status).toBe(S.DELIVERED);
    await a.track(acc, 'DL1');
    expect(calls.filter((x) => x.url!.includes('issue-token')).length).toBe(1); // token cached
  });
  it('re-auths once on 401 and reports bad credentials', async () => {
    let first = true;
    handler = (call) => (call.url!.includes('issue-token') ? { data: { access_token: 'T' + calls.length } } : first ? ((first = false), { status: 401, data: {} }) : { data: { data: { order_status: 'In Transit' } } });
    expect((await a.track(c(), 'A')).status).toBe(S.IN_TRANSIT);
    handler = () => ({ status: 400, data: { message: 'invalid' } });
    await expect(a.verifyCredentials(c())).rejects.toThrow(/auth failed/);
  });
  it('sandbox host', async () => {
    handler = h({ status: 404, data: {} });
    await a.track(ctx(Courier.PATHAO, { clientId: 'i', clientSecret: 's', username: 'u', password: 'p' }, true), 'N');
    expect(calls[0].base).toBe('https://courier-api-sandbox.pathao.com');
  });
});

describe('Bosta', () => {
  const a = new BostaAdapter();
  it('sends raw key in Authorization and uses state + timeline', async () => {
    handler = () => ({ data: { _id: '1', state: { code: 45, value: 'Delivered' }, receiver: { fullName: 'Sara' }, timeline: [{ value: 'Created', date: '2026-11-01T08:00:00Z' }, { value: 'Delivered', date: '2026-11-03T08:00:00Z' }] } });
    const r = await a.track(ctx(Courier.BOSTA, { apiKey: 'KEY' }), '123');
    expect(calls[0].url).toBe('/api/v2/deliveries/business/123');
    expect(calls[0].defaults.Authorization).toBe('KEY');
    expect(r.status).toBe(S.DELIVERED);
    expect(r.receiverName).toBe('Sara');
  });
  it('404 not found; 401 error', async () => {
    handler = () => ({ status: 404, data: {} });
    expect((await a.track(ctx(Courier.BOSTA, { apiKey: 'K' }), 'x')).found).toBe(false);
    handler = () => ({ status: 401, data: {} });
    await expect(a.verifyCredentials(ctx(Courier.BOSTA, { apiKey: 'K' }))).rejects.toThrow(/Unauthorized/);
  });
});

describe('Shiprocket', () => {
  const a = new ShiprocketAdapter();
  const c = () => ctx(Courier.SHIPROCKET, { email: 'api@x.com', password: 'p' });
  it('logs in, tracks AWB, parses IST activities', async () => {
    handler = (call) =>
      call.url === '/auth/login'
        ? { data: { token: 'JWT' } }
        : { data: { tracking_data: { track_status: 1, shipment_status: 7, shipment_track: [{ current_status: 'Delivered', delivered_to: 'Amit' }], shipment_track_activities: [{ date: '2026-11-02 09:00:00', 'sr-status-label': 'OUT FOR DELIVERY', location: 'Pune' }, { date: '2026-11-02 14:00:00', 'sr-status-label': 'DELIVERED', location: 'Pune' }] } } };
    const r = await a.track(c(), '1432648');
    expect(calls[1].url).toBe('/courier/track/awb/1432648');
    expect(calls[1].defaults.Authorization).toBe('Bearer JWT');
    expect(r.status).toBe(S.DELIVERED);
    expect(r.events[1].occurredAt.toISOString()).toBe('2026-11-02T08:30:00.000Z');
  });
  it('track_status 0 -> not found', async () => {
    handler = (call) => (call.url === '/auth/login' ? { data: { token: 'J' } } : { data: { tracking_data: { track_status: 0, error: 'Not found' } } });
    expect((await a.track(c(), 'bad')).found).toBe(false);
  });
});

describe('Tranzo', () => {
  const a = new TranzoAdapter();
  const c = () => ctx(Courier.TRANZO, { apiToken: 'tok', baseUrl: 'https://api.example-tranzo.test/' });
  it('requires an https baseUrl', async () => {
    await expect(a.track(ctx(Courier.TRANZO, { apiToken: 't' }), 'T1')).rejects.toThrow(/base URL/);
  });
  it('sends api-token + tracking_numbers list and finds nested status objects', async () => {
    handler = () => ({ data: { data: [{ tracking_number: 'T1', history: [{ order_status_code: '1004', order_status: 'Shipment Picked', status_date_time: '2026-09-24T10:00:00' }, { order_status_code: '1005', order_status: 'Shipper Warehouse', status_date_time: '2026-09-24T12:00:00' }, { order_status_code: '1010', order_status: 'Delivered', status_date_time: '2026-09-26T12:00:00' }] }] } });
    const r = await a.track(c(), 'T1');
    expect(calls[0].url).toBe('/api/custom/v1/track-order/');
    expect(calls[0].params.tracking_numbers).toBe('["T1"]');
    expect(calls[0].defaults['api-token']).toBe('tok');
    expect(r.events.length).toBe(3);
    expect(r.status).toBe(S.DELIVERED);
  });
  it('empty -> not found', async () => {
    handler = () => ({ data: { data: [] } });
    expect((await a.track(c(), 'T9')).found).toBe(false);
  });
});

describe('capabilities', () => {
  it('all are tracking-only and unverified', () => {
    for (const a of [new EcourierAdapter(), new RedxAdapter(), new PathaoAdapter(), new BostaAdapter(), new ShiprocketAdapter(), new TranzoAdapter()]) {
      expect(a.capabilities.track).toEqual({ supported: true, verified: false });
      expect(a.capabilities.book.supported).toBe(false);
    }
  });
});
