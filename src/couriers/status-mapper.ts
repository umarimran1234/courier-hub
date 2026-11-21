import { Courier, ShipmentStatus } from '@prisma/client';

/**
 * Maps a courier's raw status text/code to our normalized ShipmentStatus.
 *
 * PostEx and Leopards do not publish a complete status list, so mapping is rule based
 * (ordered regex rules, first match wins) instead of an exact lookup. Unknown strings
 * return UNKNOWN and are recorded in the UnmappedStatus table so you can extend the rules.
 *
 * Order matters: returns/cancel/failure are checked before "delivered", and
 * "out for delivery" before "delivered".
 */

// Exact code overrides (documented codes only).
const CODE_OVERRIDES: Partial<Record<Courier, Record<string, ShipmentStatus>>> = {
  TCS: {
    OK: ShipmentStatus.DELIVERED, // deliveryinfo.code "OK" = Delivered (TCS guide)
    SC: ShipmentStatus.ON_HOLD, // "Awaiting Receiver Collection"
    RO: ShipmentStatus.RETURNED, // "Return To Origin"
    DBC: ShipmentStatus.IN_TRANSIT, // delay codes: still moving
    DFC: ShipmentStatus.IN_TRANSIT,
    DAE: ShipmentStatus.IN_TRANSIT,
    DFM: ShipmentStatus.IN_TRANSIT,
  },
};

interface Rule {
  re: RegExp;
  status: ShipmentStatus;
}

const RULES: Rule[] = [
  { re: /cancel/i, status: ShipmentStatus.CANCELLED },
  { re: /\blost\b|damag|missing|misplac|stolen|destroyed/i, status: ShipmentStatus.LOST_OR_DAMAGED },

  // Returns. "returned"/"return to origin"/"delivered to shipper" = finished; any other return wording = in progress.
  {
    re: /\breturned\b|return(ed)? to (origin|shipper|merchant|sender)|\brto\b.*(deliver|complete|received)|delivered to (shipper|merchant|sender)|received (by|at) (shipper|merchant)|shipper received/i,
    status: ShipmentStatus.RETURNED,
  },
  { re: /\breturn|\brto\b|out for return|reverse/i, status: ShipmentStatus.RETURN_IN_PROGRESS },

  // Failed / unsuccessful delivery attempts.
  {
    re: /un-?delivered|not delivered|undelivery|delivery (un)?successful|unsuccessful|attempt(ed)?|refus|no response|not available|not answer|incorrect address|wrong address|address (not|issue)|consignee (not|refus|unavail)|customer (not|refus|unavail)|closed|reschedul|re-?attempt|failed/i,
    status: ShipmentStatus.DELIVERY_ATTEMPT_FAILED,
  },

  // Holds / reviews / waiting for the customer.
  {
    re: /on hold|\bhold\b|awaiting (receiver|customer|consignee|collection)|self[- ]?collect|ready (for|to) (collect|be collected)|available for (pickup|collection)|under (review|verification)|verification|pending (verification|approval|confirmation)|delivery under review|shipper advice|disputed/i,
    status: ShipmentStatus.ON_HOLD,
  },

  { re: /out for delivery|\bofd\b|with (the )?(courier|rider)|rider assigned|assigned to (rider|courier)|dispatched for delivery|on (the )?way to (consignee|customer)|out-for-delivery/i, status: ShipmentStatus.OUT_FOR_DELIVERY },

  { re: /\bdelivered\b|shipment delivered|successfully delivered|delivery completed/i, status: ShipmentStatus.DELIVERED },

  // Not yet with the courier.
  {
    re: /unbooked|un-booked|booked|booking|created|order placed|info(rmation)? received|data received|manifest(ed)? (created|generated)|pickup (request|scheduled|pending|not)|awaiting pick|pending pick|shipment (booked|created|registered)|shipper (booking|data)|not yet picked/i,
    status: ShipmentStatus.CREATED,
  },

  { re: /picked( up)?|pick-?up (done|completed|successful)|collected from (shipper|merchant)|received from (shipper|merchant)|shipment (picked|collected)/i, status: ShipmentStatus.PICKED_UP },

  {
    re: /transit|arrived|departed|dispatch|en-?route|warehouse|ware house|facility|\bhub\b|received at|reached|forwarded|sorted|sorting|bagged|bagging|loaded|in station|origin|destination|station|route|connected|gateway|network/i,
    status: ShipmentStatus.IN_TRANSIT,
  },
];

export interface MapResult {
  status: ShipmentStatus;
  matched: boolean;
}

export function mapStatus(courier: Courier, raw: string | undefined | null, code?: string | null): MapResult {
  const text = (raw ?? '').toString().trim();
  const c = (code ?? '').toString().trim().toUpperCase();

  if (c && CODE_OVERRIDES[courier]?.[c]) {
    return { status: CODE_OVERRIDES[courier]![c], matched: true };
  }
  if (!text) return { status: ShipmentStatus.UNKNOWN, matched: false };

  for (const rule of RULES) {
    if (rule.re.test(text)) return { status: rule.status, matched: true };
  }
  return { status: ShipmentStatus.UNKNOWN, matched: false };
}

const TERMINAL = new Set<ShipmentStatus>([
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNED,
  ShipmentStatus.CANCELLED,
  ShipmentStatus.LOST_OR_DAMAGED,
]);

/**
 * Decide the "current" event from a history list.
 * A terminal event (delivered / returned / cancelled / lost) wins over non-terminal ones, because courier
 * timestamps are sometimes unparsable or listed newest-first; otherwise the chronologically latest event wins.
 * UNKNOWN events are ignored if any classified event exists.
 */
export function resolveCurrent<T extends { status: ShipmentStatus; occurredAt: Date }>(events: T[]): T | undefined {
  if (!events.length) return undefined;
  const byTime = (a: T, b: T) => a.occurredAt.getTime() - b.occurredAt.getTime();
  const terminal = events.filter((e) => TERMINAL.has(e.status)).sort(byTime);
  if (terminal.length) return terminal[terminal.length - 1];
  const known = events.filter((e) => e.status !== ShipmentStatus.UNKNOWN);
  const pool = known.length ? known : events;
  return [...pool].sort(byTime)[pool.length - 1];
}
