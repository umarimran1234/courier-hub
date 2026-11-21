import { Courier, ShipmentStatus } from '@prisma/client';

export { Courier, ShipmentStatus };

export const TERMINAL_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNED,
  ShipmentStatus.CANCELLED,
  ShipmentStatus.LOST_OR_DAMAGED,
];

export interface AccountContext {
  id: string;
  courier: Courier;
  sandbox: boolean;
  credentials: Record<string, any>;
}

export interface BookingInput {
  orderRef: string;
  consignee: {
    name: string;
    phone: string;
    phone2?: string;
    email?: string;
    address: string;
    city: string;
  };
  /** Cash to collect. 0 for prepaid. */
  codAmount: number;
  weightKg: number;
  pieces: number;
  itemsDescription?: string;
  remarks?: string;
  fragile?: boolean;
  orderType?: 'NORMAL' | 'REVERSE' | 'REPLACEMENT';
  /** PostEx: pickupAddressCode. */
  pickupAddressCode?: string;
  /** TCS: costCenterCode / serviceCode override. Leopards: shipment_type. */
  serviceCode?: string;
}

export interface BookingResult {
  trackingNumber: string;
  labelUrl?: string;
  raw: unknown;
}

export interface TrackEvent {
  status: ShipmentStatus;
  rawStatus: string;
  occurredAt: Date;
  location?: string;
  note?: string;
}

export interface TrackResult {
  trackingNumber: string;
  found: boolean;
  status: ShipmentStatus;
  rawStatus: string;
  events: TrackEvent[];
  deliveredAt?: Date;
  receiverName?: string;
  raw: unknown;
}

export interface CityInfo {
  id?: string;
  name: string;
  extra?: Record<string, unknown>;
}

export interface Capabilities {
  /** `verified: false` means the endpoint shape is based on partial docs and must be checked against live responses. */
  book: { supported: boolean; verified: boolean };
  track: { supported: boolean; verified: boolean };
  trackBulk: { supported: boolean; verified: boolean };
  cancel: { supported: boolean; verified: boolean };
  label: { supported: boolean; verified: boolean };
  cities: { supported: boolean; verified: boolean };
  webhook: { supported: boolean; verified: boolean };
  paymentStatus: { supported: boolean; verified: boolean };
  statusCatalog: { supported: boolean; verified: boolean };
}

export interface CourierAdapter {
  readonly courier: Courier;
  readonly capabilities: Capabilities;
  /** Names of credential fields this courier needs (for validation + docs). */
  readonly requiredCredentials: string[];

  verifyCredentials(ctx: AccountContext): Promise<void>;
  book(ctx: AccountContext, input: BookingInput): Promise<BookingResult>;
  track(ctx: AccountContext, trackingNumber: string): Promise<TrackResult>;
  trackMany(ctx: AccountContext, trackingNumbers: string[]): Promise<TrackResult[]>;
  cancel(ctx: AccountContext, trackingNumber: string): Promise<{ ok: boolean; message?: string; raw: unknown }>;
  getLabel(ctx: AccountContext, trackingNumber: string): Promise<{ contentType: string; data: Buffer } | { url: string }>;
  getCities(ctx: AccountContext): Promise<CityInfo[]>;
  getPaymentStatus?(ctx: AccountContext, trackingNumber: string): Promise<unknown>;
  /** The courier's own list of status codes/names (where the API exposes one). */
  getStatusCatalog?(ctx: AccountContext): Promise<unknown>;
  /** Parse a push/webhook payload. Return null if it does not contain a tracking update. */
  parseWebhook?(payload: any): { trackingNumber: string; rawStatus: string; occurredAt?: Date; note?: string } | null;
}
