import { Courier, ShipmentStatus as S } from '@prisma/client';
import { CourierHttp } from '../src/couriers/http-client';
import { FedexAdapter } from '../src/couriers/adapters/fedex.adapter';
import { DhlAdapter } from '../src/couriers/adapters/dhl.adapter';
import { AramexAdapter } from '../src/couriers/adapters/aramex.adapter';
import { AccountContext } from '../src/couriers/courier.types';
import { NotSupportedError } from '../src/couriers/courier.errors';
import { mapStatus } from '../src/couriers/status-mapper';
import { parseIsoOrMsDate } from '../src/couriers/util';

type Call = { method?: string; url?: string; data?: any; params?: any; headers?: any };
let calls: Call[] = [];
let handler: (c: Call) => { status?: number; data: any };

beforeEach(() => {
  calls = [];
  jest.spyOn(CourierHttp.prototype, 'request').mockImplementation(async (cfg: any) => {
    calls.push(cfg);
    const r = handler(cfg);
    return { status: r.status ?? 200, data: r.data, headers: {} } as any;
  });
});
afterEach(() => jest.restoreAllMocks());

const ctx = (courier: Courier, credentials: any, sandbox = false): AccountContext => ({ id: `acc-${courier}-${Math.random()}`, courier, sandbox, credentials });

describe('FedEx adapter', () => {
  const a = new FedexAdapter();
  const mk = () => ctx(Courier.FEDEX, { clientId: 'cid', clientSecret: 'sec' });
  const delivered = {
    trackingNumberInfo: { trackingNumber: '794600000001' },
    latestStatusDetail: { derivedCode: 'DL', statusByLocale: 'Delivered', code: 'DL' },
    dateAndTimes: [{ type: 'ACTUAL_DELIVERY', dateTime: '2026-11-10T14:30:00+05:00' }],
    deliveryDetails: { receivedByName: 'A. Khan' },
    scanEvents: [
      { date: '2026-11-10T14:30:00+05:00', derivedStatus: 'Delivered', derivedStatusCode: 'DL', scanLocation: { city: 'LAHORE', countryCode: 'PK' } },
      { date: '2026-11-10T08:00:00+05:00', derivedStatus: 'On FedEx vehicle for delivery', derivedStatusCode: 'OD', scanLocation: { city: 'LAHORE', countryCode: 'PK' } },
      { date: '2026-11-07T10:00:00+04:00', derivedStatus: 'Departed FedEx location', derivedStatusCode: 'IT', scanLocation: { city: 'DUBAI', countryCode: 'AE' } },
    ],
  };
  const oauth = (c: Call) => (c.url === '/oauth/token' ? { data: { access_token: 'TKN', expires_in: 3600 } } : null);

  it('verifies credentials via the OAuth form post', async () => {
    handler = (c) => oauth(c)!;
    await a.verifyCredentials(mk());
    expect(calls[0].url).toBe('/oauth/token');
    expect(calls[0].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0].data).toContain('grant_type=client_credentials');
    expect(calls[0].data).toContain('client_id=cid');
  });

  it('rejects bad credentials with an Unauthorized error', async () => {
    handler = () => ({ status: 401, data: { errors: [{ code: 'NOT.AUTHORIZED.ERROR', message: 'Invalid client' }] } });
    await expect(a.verifyCredentials(mk())).rejects.toThrow(/Unauthorized: Invalid client/);
  });

  it('uses csp_credentials when child key/secret are given', async () => {
    handler = (c) => oauth(c)!;
    await a.verifyCredentials(ctx(Courier.FEDEX, { clientId: 'c', clientSecret: 's', childKey: 'ck', childSecret: 'cs' }));
    expect(calls[0].data).toContain('grant_type=csp_credentials');
    expect(calls[0].data).toContain('child_key=ck');
  });

  it('tracks a delivered parcel: headline status, events, delivery time, receiver', async () => {
    handler = (c) => oauth(c) ?? { data: { output: { completeTrackResults: [{ trackingNumber: '794600000001', trackResults: [delivered] }] } } };
    const r = await a.track(mk(), '794600000001');
    expect(r).toMatchObject({ found: true, status: S.DELIVERED, receiverName: 'A. Khan' });
    expect(r.events).toHaveLength(3);
    expect(r.events.map((e) => e.status)).toEqual([S.DELIVERED, S.OUT_FOR_DELIVERY, S.IN_TRANSIT]);
    expect(r.events[0].location).toBe('LAHORE, PK');
    expect(r.deliveredAt?.toISOString()).toBe('2026-11-10T09:30:00.000Z');
    const track = calls.find((c) => c.url === '/track/v1/trackingnumbers')!;
    expect(track.headers.Authorization).toBe('Bearer TKN');
    expect(track.data.trackingInfo[0].trackingNumberInfo.trackingNumber).toBe('794600000001');
  });

  it('reports unknown numbers as not found', async () => {
    handler = (c) => oauth(c) ?? { data: { output: { completeTrackResults: [{ trackingNumber: '1', trackResults: [{ error: { code: 'TRACKING.TRACKINGNUMBER.NOTFOUND', message: 'Tracking number cannot be found' } }] }] } } };
    const r = await a.track(mk(), '1');
    expect(r.found).toBe(false);
    expect(r.rawStatus).toMatch(/cannot be found/);
  });

  it('caches the token and chunks at 30 numbers per request', async () => {
    handler = (c) => oauth(c) ?? { data: { output: { completeTrackResults: [] } } };
    const x = mk();
    const nums = Array.from({ length: 31 }, (_, i) => String(700000000000 + i));
    const res = await a.trackMany(x, nums);
    expect(res).toHaveLength(31);
    expect(calls.filter((c) => c.url === '/oauth/token')).toHaveLength(1);
    const tracks = calls.filter((c) => c.url === '/track/v1/trackingnumbers');
    expect(tracks).toHaveLength(2);
    expect(tracks[0].data.trackingInfo).toHaveLength(30);
  });

  it('re-authenticates once when the token is rejected', async () => {
    let n = 0;
    handler = (c) => {
      if (c.url === '/oauth/token') return { data: { access_token: `T${++n}` } };
      return c.headers.Authorization === 'Bearer T1' ? { status: 401, data: {} } : { data: { output: { completeTrackResults: [{ trackingNumber: '794600000001', trackResults: [delivered] }] } } };
    };
    const r = await a.track(mk(), '794600000001');
    expect(r.status).toBe(S.DELIVERED);
    expect(n).toBe(2);
  });

  it('is tracking-only', async () => {
    await expect(a.book()).rejects.toBeInstanceOf(NotSupportedError);
    expect(a.capabilities.book.supported).toBe(false);
  });
});

describe('DHL adapter', () => {
  const a = new DhlAdapter();
  const mk = () => ctx(Courier.DHL, { apiKey: 'KEY' });

  it('verify: accepts 200/404, rejects 401', async () => {
    handler = () => ({ status: 404, data: { title: 'No result found' } });
    await expect(a.verifyCredentials(mk())).resolves.toBeUndefined();
    handler = () => ({ status: 401, data: { detail: 'Unauthorized' } });
    await expect(a.verifyCredentials(mk())).rejects.toThrow(/invalid DHL API key/);
  });

  it('tracks in-transit shipment (statusCode transit)', async () => {
    handler = () => ({
      data: {
        shipments: [
          {
            id: '1234567890',
            status: { timestamp: '2026-11-09T12:00:00Z', statusCode: 'transit', status: 'IN TRANSIT', description: 'Shipment has departed from a DHL facility' },
            events: [
              { timestamp: '2026-11-08T09:00:00Z', statusCode: 'pre-transit', description: 'Shipment picked up', location: { address: { addressLocality: 'DUBAI - UNITED ARAB EMIRATES' } } },
              { timestamp: '2026-11-09T12:00:00Z', statusCode: 'transit', description: 'Departed from a DHL facility', location: { address: { addressLocality: 'DUBAI', countryCode: 'AE' } } },
            ],
          },
        ],
      },
    });
    const r = await a.track(mk(), '1234567890');
    expect(r).toMatchObject({ found: true, status: S.IN_TRANSIT });
    expect(r.events).toHaveLength(2);
    expect(calls[0].params.trackingNumber).toBe('1234567890');
    expect(calls[0].url).toBe('/track/shipments');
  });

  it('tracks delivered shipment with proof of delivery', async () => {
    handler = () => ({
      data: {
        shipments: [
          {
            id: '1234567890',
            status: { timestamp: '2026-11-12T10:00:00Z', statusCode: 'delivered', description: 'Delivered - Signed for by : A KHAN' },
            events: [{ timestamp: '2026-11-12T10:00:00Z', statusCode: 'delivered', description: 'Delivered' }],
            details: { proofOfDelivery: { timestamp: '2026-11-12T10:00:00Z', signed: { name: 'A KHAN' } } },
          },
        ],
      },
    });
    const r = await a.track(mk(), '1234567890');
    expect(r).toMatchObject({ status: S.DELIVERED, receiverName: 'A KHAN' });
    expect(r.deliveredAt?.toISOString()).toBe('2026-11-12T10:00:00.000Z');
  });

  it('404 -> found=false; 429 -> retriable error; bulk makes one call per number', async () => {
    handler = () => ({ status: 404, data: { title: 'No result found for query' } });
    expect((await a.track(mk(), '0000')).found).toBe(false);
    handler = () => ({ status: 429, data: {} });
    await expect(a.track(mk(), '0000')).rejects.toMatchObject({ retriable: true });
    calls = [];
    handler = () => ({ status: 404, data: {} });
    const res = await a.trackMany(mk(), ['a1111', 'a2222', 'a3333', 'a4444', 'a5555', 'a6666', 'a7777']);
    expect(res).toHaveLength(7);
    expect(calls).toHaveLength(7);
  });

  it('sends the key header', () => {
    handler = () => ({ data: {} });
    expect((a as any).http(mk()).ax.defaults.headers['DHL-API-Key']).toBe('KEY');
  });
});

describe('Aramex adapter', () => {
  const a = new AramexAdapter();
  const creds = { userName: 'u@x.com', password: 'p', accountNumber: '12345', accountPin: '654321', accountEntity: 'KHI', accountCountryCode: 'PK' };
  const mk = (sandbox = false) => ctx(Courier.ARAMEX, creds, sandbox);
  const ok = (value: any[], missing: string[] = []) => ({
    data: { HasErrors: false, Notifications: [], NonExistingWaybills: missing, TrackingResults: [{ Key: '44123456789', Value: value }] },
  });

  it('sends ClientInfo + shipments to TrackShipments', async () => {
    handler = () => ok([{ WaybillNumber: '44123456789', UpdateDescription: 'Shipment received at origin', UpdateDateTime: '/Date(1762000000000+0300)/', UpdateLocation: 'Karachi, Pakistan' }]);
    await a.track(mk(), '44123456789');
    expect(calls[0].url).toBe('/TrackShipments');
    expect(calls[0].data.ClientInfo).toMatchObject({ UserName: 'u@x.com', AccountNumber: '12345', AccountPin: '654321', AccountEntity: 'KHI', AccountCountryCode: 'PK', Version: 'v1.0' });
    expect(calls[0].data.Shipments).toEqual(['44123456789']);
  });

  it('parses the update history, /Date()/ stamps and delivered state', async () => {
    handler = () =>
      ok([
        { WaybillNumber: '44123456789', UpdateDescription: 'Shipment picked up', UpdateDateTime: '/Date(1762000000000+0300)/', UpdateLocation: 'Karachi, Pakistan' },
        { WaybillNumber: '44123456789', UpdateDescription: 'Shipment arrived at Aramex facility', UpdateDateTime: '/Date(1762100000000+0300)/', UpdateLocation: 'Dubai, UAE' },
        { WaybillNumber: '44123456789', UpdateDescription: 'Delivered', UpdateDateTime: '/Date(1762200000000+0300)/', UpdateLocation: 'Dubai, UAE', Comments: 'Signed by Ali' },
      ]);
    const r = await a.track(mk(), '44123456789');
    expect(r).toMatchObject({ found: true, status: S.DELIVERED });
    expect(r.events.map((e) => e.status)).toEqual([S.PICKED_UP, S.IN_TRANSIT, S.DELIVERED]);
    expect(r.deliveredAt?.getTime()).toBe(1762200000000);
    expect(r.events[2].note).toBe('Signed by Ali');
  });

  it('marks non-existing waybills as not found', async () => {
    handler = () => ({ data: { HasErrors: false, Notifications: [], NonExistingWaybills: ['999'], TrackingResults: [] } });
    const r = await a.track(mk(), '999');
    expect(r.found).toBe(false);
  });

  it('surfaces invalid ClientInfo as Unauthorized', async () => {
    handler = () => ({ data: { HasErrors: true, Notifications: [{ Code: 'ERR01', Message: 'ClientInfo - Invalid account information' }], TrackingResults: [] } });
    await expect(a.verifyCredentials(mk())).rejects.toThrow(/Unauthorized: ClientInfo - Invalid account information/);
  });

  it('uses the sandbox host when asked, and is tracking-only', async () => {
    handler = () => ok([]);
    expect((a as any).http(mk(true)).ax.defaults.baseURL).toContain('ws.dev.aramex.net');
    expect((a as any).http(mk(false)).ax.defaults.baseURL).toContain('ws.aramex.net/ShippingAPI.V2');
    await expect(a.book()).rejects.toBeInstanceOf(NotSupportedError);
  });
});

describe('international status mapping + date helper', () => {
  it('maps customs and clearance wording', () => {
    expect(mapStatus(Courier.ARAMEX, 'Held by customs for clearance').status).toBe(S.ON_HOLD);
    expect(mapStatus(Courier.DHL, 'Clearance processing complete at Dubai').status).toBe(S.IN_TRANSIT);
    expect(mapStatus(Courier.DHL, 'Customs status updated').status).toBe(S.IN_TRANSIT);
    expect(mapStatus(Courier.FEDEX, 'Shipment exception', 'SE').status).toBe(S.ON_HOLD);
    expect(mapStatus(Courier.FEDEX, 'anything', 'DL').status).toBe(S.DELIVERED);
    expect(mapStatus(Courier.DHL, 'whatever', 'pre-transit').status).toBe(S.CREATED);
    expect(mapStatus(Courier.DHL, 'whatever', 'failure').status).toBe(S.DELIVERY_ATTEMPT_FAILED);
  });
  it('parses ISO and /Date()/ stamps', () => {
    expect(parseIsoOrMsDate('/Date(1762200000000+0300)/')?.getTime()).toBe(1762200000000);
    expect(parseIsoOrMsDate('2026-11-10T09:30:00Z')?.toISOString()).toBe('2026-11-10T09:30:00.000Z');
    expect(parseIsoOrMsDate('garbage')).toBeUndefined();
  });
});
