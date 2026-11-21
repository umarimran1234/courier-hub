import { Courier, ShipmentStatus as S } from '@prisma/client';
import { CourierHttp } from '../src/couriers/http-client';
import { PostexAdapter } from '../src/couriers/adapters/postex.adapter';
import { LeopardsAdapter } from '../src/couriers/adapters/leopards.adapter';
import { TcsAdapter } from '../src/couriers/adapters/tcs.adapter';
import { AccountContext } from '../src/couriers/courier.types';

type Call = { method?: string; url?: string; data?: any; params?: any; headers?: any };
let calls: Call[] = [];
let handler: (c: Call) => { status?: number; data: any; headers?: any };

beforeEach(() => {
  calls = [];
  jest.spyOn(CourierHttp.prototype, 'request').mockImplementation(async (cfg: any) => {
    calls.push(cfg);
    const r = handler(cfg);
    return { status: r.status ?? 200, data: r.data, headers: r.headers ?? {} } as any;
  });
});
afterEach(() => jest.restoreAllMocks());

const ctx = (courier: Courier, credentials: any, sandbox = false): AccountContext => ({ id: `acc-${courier}-${Math.random()}`, courier, sandbox, credentials });

describe('PostEx adapter', () => {
  const a = new PostexAdapter();
  const c = ctx(Courier.POSTEX, { token: 't', pickupAddressCode: '001' });

  it('books with v3 payload and returns tracking number', async () => {
    handler = () => ({ data: { statusCode: '200', statusMessage: 'OK', dist: { trackingNumber: 'CX-100' } } });
    const r = await a.book(c, {
      orderRef: '#1001',
      consignee: { name: 'Ali Khan', phone: '+92 300 1234567', address: 'House 1 Street 2', city: 'Lahore' },
      codAmount: 2500,
      weightKg: 1,
      pieces: 2,
    });
    expect(r.trackingNumber).toBe('CX-100');
    expect(calls[0].url).toBe('/v3/create-order');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].data).toMatchObject({ customerPhone: '03001234567', invoicePayment: '2500', items: 2, orderRefNumber: '#1001', orderType: 'Normal', pickupAddressCode: '001', cityName: 'Lahore' });
  });

  it('surfaces courier validation errors', async () => {
    handler = () => ({ data: { statusCode: '400', statusMessage: 'Invalid city' } });
    await expect(a.book(c, { orderRef: 'x', consignee: { name: 'A B', phone: '0300', address: 'addr xx', city: 'Nowhere' }, codAmount: 1, weightKg: 1, pieces: 1 })).rejects.toThrow(/Invalid city/);
  });

  it('tracks: parses history, headline status and delivery time', async () => {
    handler = () => ({
      data: {
        statusCode: '200',
        dist: {
          trackingNumber: 'CX-100',
          transactionStatus: 'Delivered',
          transactionStatusHistory: [
            { transactionStatusMessage: 'Order Booked', transactionStatusMessageCode: '0001', modifiedDatetime: '2026-11-01 10:00:00' },
            { transactionStatusMessage: 'Out For Delivery', modifiedDatetime: '2026-11-03 09:00:00' },
            { transactionStatusMessage: 'Delivered', modifiedDatetime: '2026-11-03 15:00:00' },
          ],
        },
      },
    });
    const r = await a.track(c, 'CX-100');
    expect(r.found).toBe(true);
    expect(r.status).toBe(S.DELIVERED);
    expect(r.events.map((e) => e.status)).toEqual([S.CREATED, S.OUT_FOR_DELIVERY, S.DELIVERED]);
    expect(r.deliveredAt?.toISOString()).toBe('2026-11-03T10:00:00.000Z');
  });

  it('tracks: unknown tracking number -> found=false (no throw)', async () => {
    handler = () => ({ data: { statusCode: '400', statusMessage: 'No order found against this tracking number' } });
    const r = await a.track(c, 'NOPE');
    expect(r.found).toBe(false);
    expect(r.status).toBe(S.UNKNOWN);
  });

  it('bulk track falls back to per-number when bulk fails', async () => {
    handler = (cfg) =>
      cfg.url === '/v1/track-bulk-order'
        ? { data: { statusCode: '500', statusMessage: 'boom' } }
        : { data: { statusCode: '200', dist: { trackingNumber: cfg.url!.split('/').pop(), transactionStatus: 'Out For Delivery' } } };
    const rs = await a.trackMany(c, ['A1', 'A2']);
    expect(rs.map((r) => r.status)).toEqual([S.OUT_FOR_DELIVERY, S.OUT_FOR_DELIVERY]);
  });

  it('bulk track uses one call when bulk works', async () => {
    handler = () => ({ data: { statusCode: '200', dist: [{ trackingNumber: 'A1', transactionStatus: 'Booked' }, { trackingNumber: 'A2', transactionStatus: 'Delivered' }] } });
    const rs = await a.trackMany(c, ['A1', 'A2']);
    expect(calls).toHaveLength(1);
    expect(rs.map((r) => r.status)).toEqual([S.CREATED, S.DELIVERED]);
  });

  it('401 is reported as unauthorized', async () => {
    handler = () => ({ status: 401, data: { message: 'bad token' } });
    await expect(a.track(c, 'X')).rejects.toThrow(/Unauthorized/);
  });

  it('cancel uses PUT /v1/cancel-order', async () => {
    handler = () => ({ data: { statusCode: '200', statusMessage: 'Order cancelled' } });
    const r = await a.cancel(c, 'CX-1');
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: '/v1/cancel-order', data: { trackingNumber: 'CX-1' } });
  });
});

describe('Leopards adapter', () => {
  const a = new LeopardsAdapter();
  const c = ctx(Courier.LEOPARDS, { apiKey: 'k', apiPassword: 'p' });
  const cities = { status: 1, error: 0, city_list: [{ id: '789', name: 'Lahore' }, { id: '790', name: 'Karachi' }] };

  it('resolves city name -> id and books in grams as form-encoded', async () => {
    handler = (cfg) => (cfg.url!.startsWith('getAllCities') ? { data: cities } : { data: { status: 1, track_number: 'LE1234567890', slip_link: 'https://x/slip.pdf' } });
    const r = await a.book(c, { orderRef: 'O1', consignee: { name: 'Ali', phone: '0300 1234567', address: 'Some address', city: 'lahore' }, codAmount: 1999, weightKg: 1.5, pieces: 1 });
    expect(r).toMatchObject({ trackingNumber: 'LE1234567890', labelUrl: 'https://x/slip.pdf' });
    const form = new URLSearchParams(calls[1].data);
    expect(form.get('destination_city')).toBe('789');
    expect(form.get('booked_packet_weight')).toBe('1500');
    expect(form.get('booked_packet_collect_amount')).toBe('1999');
    expect(form.get('api_key')).toBe('k');
    expect(form.get('origin_city')).toBe('self');
  });

  it('rejects unknown city with a helpful message', async () => {
    handler = () => ({ data: cities });
    await expect(a.book(c, { orderRef: 'O', consignee: { name: 'A', phone: '0300', address: 'xxxxxx', city: 'Karakoram' }, codAmount: 1, weightKg: 1, pieces: 1 })).rejects.toThrow(/Unknown destination city/);
  });

  it('tracks batch and marks missing numbers as not found', async () => {
    handler = () => ({
      data: {
        status: 1,
        packet_list: [
          {
            track_number: 'LE1',
            booked_packet_status: 'Delivered',
            'Tracking Detail': [
              { Status: 'Pickup request not send', Activity_Date: '2026-11-01', Activity_Time: '10:00 AM' },
              { Status: 'Arrival at Destination', Activity_Date: '2026-11-02', Activity_Time: '08:00 AM' },
              { Status: 'Delivered', Activity_Date: '2026-11-03', Activity_Time: '03:30 PM', Reciever_Name: 'Ali' },
            ],
          },
        ],
      },
    });
    const [ok, missing] = await a.trackMany(c, ['LE1', 'LE2']);
    expect(ok.status).toBe(S.DELIVERED);
    expect(ok.events.map((e) => e.status)).toEqual([S.CREATED, S.IN_TRANSIT, S.DELIVERED]);
    expect(ok.deliveredAt?.toISOString()).toBe('2026-11-03T10:30:00.000Z');
    expect(missing.found).toBe(false);
    expect(calls[0].params.track_numbers).toBe('LE1,LE2');
  });

  it('throws on API-level error when booking', async () => {
    handler = (cfg) => (cfg.url!.startsWith('getAllCities') ? { data: cities } : { data: { status: 0, error: 'Invalid API credentials' } });
    await expect(a.book(c, { orderRef: 'O', consignee: { name: 'A', phone: '0300', address: 'xxxxxx', city: 'Lahore' }, codAmount: 1, weightKg: 1, pieces: 1 })).rejects.toThrow(/Invalid API credentials/);
  });

  it('uses the staging host in sandbox mode', async () => {
    const spyHost = jest.fn();
    handler = (cfg) => {
      spyHost(cfg.url);
      return { data: cities };
    };
    await a.verifyCredentials({ ...c, sandbox: true });
    expect(spyHost).toHaveBeenCalledWith('getAllCities/format/json/');
  });

  it('parses a push payload tolerantly', () => {
    expect(a.parseWebhook!({ track_number: 'LE1', status: 'Out for delivery', date: '2026-11-03', time: '09:00 AM' })).toMatchObject({ trackingNumber: 'LE1', rawStatus: 'Out for delivery' });
    expect(a.parseWebhook!({ foo: 'bar' })).toBeNull();
  });
});

describe('TCS adapter', () => {
  const a = new TcsAdapter();
  const creds = {
    username: 'u', password: 'p', accountNo: '123456', costCenterCode: '01', shipperName: 'My Store', shipperAddress: 'Warehouse 1', shipperCity: 'Lahore', shipperMobile: '03001112223',
  };

  it('authenticates then books with accesstoken in body and doc field names', async () => {
    const c = ctx(Courier.TCS, creds, true);
    handler = (cfg) =>
      cfg.url === '/ecom/api/authentication/token'
        ? { data: { accesstoken: 'TOK', expiry: 'x', message: 'ok' } }
        : { data: { response: 'SUCCESS', consignmentNo: '779412326902', code: '200' } };
    const r = await a.book(c, { orderRef: 'ORD-9', consignee: { name: 'Ali Raza Khan', phone: '+923001234567', address: 'House 5, Gulberg', city: 'Karachi', email: 'a@b.com' }, codAmount: 3000, weightKg: 0.2, pieces: 1, itemsDescription: 'T-shirt' });
    expect(r.trackingNumber).toBe('779412326902');
    expect(calls[0].url).toBe('/ecom/api/authentication/token');
    const body = calls[1].data;
    expect(body.accesstoken).toBe('TOK');
    expect(body.shipperinfo).toMatchObject({ tcsaccount: '123456', countrycode: 'PK', mobile: '03001112223' });
    expect(body.consigneeinfo).toMatchObject({ firstname: 'Ali', middlename: 'Raza', lastname: 'Khan', cityname: 'Karachi', mobile: '03001234567' });
    expect(body.shipmentinfo).toMatchObject({ costcentercode: '01', codamount: 3000, weightinkg: 0.5, currency: 'PKR', servicecode: 'O', referenceno: 'ORD-9' });
    expect(body.shipmentinfo.shipmentdate).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  });

  it('enforces the TCS COD ceiling', async () => {
    await expect(a.book(ctx(Courier.TCS, creds), { orderRef: 'x', consignee: { name: 'A B', phone: '0300', address: 'xxxxxx', city: 'Lahore' }, codAmount: 300000, weightKg: 1, pieces: 1 })).rejects.toThrow(/exceeds/);
  });

  it('re-authenticates once when the token is rejected', async () => {
    const c = ctx(Courier.TCS, creds);
    let authCalls = 0;
    let bookCalls = 0;
    handler = (cfg) => {
      if (cfg.url === '/ecom/api/authentication/token') return { data: { accesstoken: `TOK${++authCalls}` } };
      bookCalls++;
      return bookCalls === 1 ? { status: 401, data: { code: '401', message: 'expired' } } : { data: { response: 'SUCCESS', consignmentNo: '1', code: '200' } };
    };
    const r = await a.book(c, { orderRef: 'x', consignee: { name: 'A B', phone: '0300', address: 'xxxxxx', city: 'Lahore' }, codAmount: 1, weightKg: 1, pieces: 1 });
    expect(r.trackingNumber).toBe('1');
    expect(authCalls).toBe(2);
  });

  it('tracks: delivered via deliveryinfo code OK', async () => {
    const c = ctx(Courier.TCS, creds);
    handler = (cfg) =>
      cfg.url === '/ecom/api/authentication/token'
        ? { data: { accesstoken: 'TOK' } }
        : {
            data: {
              shipmentinfo: [{ consignmentno: '779412326902', origin: 'LAHORE', destination: 'KARACHI' }],
              deliveryinfo: [{ consignmentno: '779412326902', station: 'KARACHI', datetime: '05/11/2026 14:20', recievedby: 'ALI', status: 'Delivered', code: 'OK' }],
              checkpoints: [
                { consignmentno: '779412326902', datetime: '03/11/2026 09:00', status: 'Arrived at TCS Facility' },
                { consignmentno: '779412326902', datetime: '05/11/2026 08:00', status: 'Out For Delivery' },
              ],
              shipmentsummary: 'Delivered',
              message: 'SUCCESS',
            },
          };
    const r = await a.track(c, '779412326902');
    expect(r.found).toBe(true);
    expect(r.status).toBe(S.DELIVERED);
    expect(r.receiverName).toBe('ALI');
    expect(r.deliveredAt?.toISOString()).toBe('2026-11-05T09:20:00.000Z');
    expect(calls[1].headers.Authorization).toBe('Bearer TOK');
    expect(calls[1].data).toEqual({ consignee: ['779412326902'] });
  });

  it('tracks: invalid CN -> found=false', async () => {
    const c = ctx(Courier.TCS, creds);
    handler = (cfg) => (cfg.url === '/ecom/api/authentication/token' ? { data: { accesstoken: 'T' } } : { data: { shipmentinfo: null, deliveryinfo: null, checkpoints: null, shipmentsummary: 'No Data Found/Invalid CN', message: 'FAIL' } });
    const r = await a.track(c, '000');
    expect(r.found).toBe(false);
  });

  it('tracks batch: only attributes rows to the matching CN', async () => {
    const c = ctx(Courier.TCS, creds);
    handler = (cfg) =>
      cfg.url === '/ecom/api/authentication/token'
        ? { data: { accesstoken: 'T' } }
        : {
            data: {
              shipmentinfo: [{ consignmentno: '1' }, { consignmentno: '2' }],
              deliveryinfo: [{ consignmentno: '1', status: 'Delivered', code: 'OK', datetime: '05/11/2026 14:20' }],
              checkpoints: [{ consignmentno: '2', status: 'Out For Delivery', datetime: '05/11/2026 08:00' }],
            },
          };
    const [r1, r2] = await a.trackMany(c, ['1', '2']);
    expect(r1.status).toBe(S.DELIVERED);
    expect(r2.status).toBe(S.OUT_FOR_DELIVERY);
  });

  it('uses bearer from /auth/api/auth when clientId/clientSecret provided', async () => {
    const c = ctx(Courier.TCS, { ...creds, clientId: '77', clientSecret: 'sec' });
    handler = (cfg) => (cfg.url === '/auth/api/auth' ? { data: { result: { accessToken: 'BEARER' }, status: true, code: '0200' } } : { data: { shipmentinfo: [{ consignmentno: '1' }], checkpoints: [{ consignmentno: '1', status: 'Out For Delivery', datetime: '05/11/2026 08:00' }] } });
    await a.track(c, '1');
    expect(calls[0].url).toBe('/auth/api/auth');
    expect(calls[0].data).toEqual({ clientId: 77, clientsecret: 'sec' });
    expect(calls[1].headers.Authorization).toBe('Bearer BEARER');
  });

  it('cancel posts ConsignmentNumber', async () => {
    const c = ctx(Courier.TCS, creds);
    handler = (cfg) => (cfg.url === '/ecom/api/authentication/token' ? { data: { accesstoken: 'T' } } : { data: { message: 'Consignment cancelled successfully', traceid: 'x' } });
    const r = await a.cancel(c, '779412326902');
    expect(r.ok).toBe(true);
    expect(calls[1].data).toMatchObject({ ConsignmentNumber: 779412326902, accesstoken: 'T' });
  });
});
