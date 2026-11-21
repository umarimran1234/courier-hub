import { Courier, ShipmentStatus as S } from '@prisma/client';
import { mapStatus, resolveCurrent } from '../src/couriers/status-mapper';

const m = (raw: string, c: Courier = Courier.POSTEX, code?: string) => mapStatus(c, raw, code).status;

describe('status mapper', () => {
  it.each([
    ['Delivered', S.DELIVERED],
    ['Shipment Delivered', S.DELIVERED],
    ['Out For Delivery', S.OUT_FOR_DELIVERY],
    ['Out for delivery', S.OUT_FOR_DELIVERY],
    ['Booked', S.CREATED],
    ['Unbooked', S.CREATED],
    ['Pickup request not send', S.CREATED],
    ['Consignment Booked', S.CREATED],
    ['Picked By PostEx', S.PICKED_UP],
    ['Shipment Picked Up', S.PICKED_UP],
    ['PostEx WareHouse', S.IN_TRANSIT],
    ['En-Route to PostEx warehouse', S.IN_TRANSIT],
    ['Arrived at TCS Facility', S.IN_TRANSIT],
    ['Arrival at Destination', S.IN_TRANSIT],
    ['Shipment Arrived at Origin Station', S.IN_TRANSIT],
    ['Delivery Under Review', S.ON_HOLD],
    ['Awaiting Receiver Collection', S.ON_HOLD],
    ['Delivery Unsuccessful - Customer not available', S.DELIVERY_ATTEMPT_FAILED],
    ['Delivery Attempted - Consignee Not Available', S.DELIVERY_ATTEMPT_FAILED],
    ['Undelivered', S.DELIVERY_ATTEMPT_FAILED],
    ['Refused by consignee', S.DELIVERY_ATTEMPT_FAILED],
    ['Returned', S.RETURNED],
    ['Returned to Shipper', S.RETURNED],
    ['Shipment Delivered to Shipper', S.RETURNED],
    ['Return To Origin', S.RETURNED],
    ['Out For Return', S.RETURN_IN_PROGRESS],
    ['Return Approved', S.RETURN_IN_PROGRESS],
    ['Cancelled', S.CANCELLED],
    ['Shipment Lost', S.LOST_OR_DAMAGED],
    ['Parcel damaged', S.LOST_OR_DAMAGED],
    ['Something nobody has seen before', S.UNKNOWN],
    ['', S.UNKNOWN],
  ])('maps "%s"', (raw, expected) => {
    expect(m(raw)).toBe(expected);
  });

  it('applies documented TCS codes before text rules', () => {
    expect(m('anything', Courier.TCS, 'OK')).toBe(S.DELIVERED);
    expect(m('anything', Courier.TCS, 'SC')).toBe(S.ON_HOLD);
    expect(m('anything', Courier.TCS, 'RO')).toBe(S.RETURNED);
    expect(m('Delay Beyond Our Control', Courier.TCS, 'DBC')).toBe(S.IN_TRANSIT);
  });

  it('flags unmatched text', () => {
    expect(mapStatus(Courier.LEOPARDS, 'zzz').matched).toBe(false);
    expect(mapStatus(Courier.LEOPARDS, 'Delivered').matched).toBe(true);
  });
});

describe('resolveCurrent', () => {
  const ev = (status: S, t: number) => ({ status, occurredAt: new Date(t) });
  it('picks latest by time', () => {
    const r = resolveCurrent([ev(S.IN_TRANSIT, 5), ev(S.CREATED, 1), ev(S.OUT_FOR_DELIVERY, 9)]);
    expect(r?.status).toBe(S.OUT_FOR_DELIVERY);
  });
  it('terminal wins over later non-terminal noise', () => {
    const r = resolveCurrent([ev(S.DELIVERED, 5), ev(S.IN_TRANSIT, 9)]);
    expect(r?.status).toBe(S.DELIVERED);
  });
  it('ignores UNKNOWN when something classified exists', () => {
    const r = resolveCurrent([ev(S.IN_TRANSIT, 5), ev(S.UNKNOWN, 9)]);
    expect(r?.status).toBe(S.IN_TRANSIT);
  });
  it('empty -> undefined', () => {
    expect(resolveCurrent([])).toBeUndefined();
  });
});
