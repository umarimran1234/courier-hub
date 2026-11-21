import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Courier, Prisma, Shipment, ShipmentStatus, Tenant } from '@prisma/client';
import { AccountsService } from '../accounts/accounts.service';
import { CourierRegistry } from '../couriers/courier.registry';
import { TERMINAL_STATUSES, TrackResult } from '../couriers/courier.types';
import { mapStatus } from '../couriers/status-mapper';
import { NotifyService } from '../notify/notify.service';
import { PrismaService } from '../prisma/prisma.service';
import { BookShipmentDto, ListShipmentsQuery, TrackBulkDto } from './shipments.dto';

type ShipmentWithEvents = Shipment & { events?: unknown[] };

@Injectable()
export class ShipmentsService {
  private log = new Logger('Shipments');

  constructor(
    private prisma: PrismaService,
    private registry: CourierRegistry,
    private accounts: AccountsService,
    private notify: NotifyService,
  ) {}

  serialize(s: ShipmentWithEvents) {
    const { bookingRaw, ...rest } = s as any;
    return rest;
  }

  // ------------------------------------------------------------------ book

  async book(tenant: Tenant, dto: BookShipmentDto) {
    const courier = this.registry.parse(dto.courier);
    const adapter = this.registry.get(courier);

    if (!dto.allowDuplicate) {
      const dup = await this.prisma.shipment.findFirst({
        where: { tenantId: tenant.id, courier, orderRef: dto.orderRef, status: { not: ShipmentStatus.CANCELLED } },
      });
      if (dup) {
        throw new ConflictException({
          message: `Order "${dto.orderRef}" is already booked with ${courier} (${dup.trackingNumber}). Pass allowDuplicate=true to book again.`,
          shipmentId: dup.id,
          trackingNumber: dup.trackingNumber,
        });
      }
    }

    const account = await this.accounts.resolve(tenant.id, courier, dto.accountId);
    const ctx = this.accounts.toContext(account);

    const result = await adapter.book(ctx, {
      orderRef: dto.orderRef,
      consignee: dto.consignee,
      codAmount: dto.codAmount,
      weightKg: dto.weightKg ?? 0.5,
      pieces: dto.pieces ?? 1,
      itemsDescription: dto.itemsDescription,
      remarks: dto.remarks,
      fragile: dto.fragile,
      orderType: dto.orderType,
      pickupAddressCode: dto.pickupAddressCode,
      serviceCode: dto.serviceCode,
    });

    const shipment = await this.prisma.shipment.create({
      data: {
        tenantId: tenant.id,
        accountId: account.id,
        courier,
        trackingNumber: result.trackingNumber,
        orderRef: dto.orderRef,
        status: ShipmentStatus.CREATED,
        rawStatus: 'Booked',
        codAmount: dto.codAmount,
        consigneeName: dto.consignee.name,
        consigneePhone: dto.consignee.phone,
        city: dto.consignee.city,
        labelUrl: result.labelUrl,
        bookingRaw: result.raw as Prisma.InputJsonValue,
        events: { create: [{ status: ShipmentStatus.CREATED, rawStatus: 'Booked', occurredAt: new Date() }] },
      },
    });
    return this.serialize(shipment);
  }

  // ------------------------------------------------------------------ read

  async get(tenant: Tenant, id: string) {
    const s = await this.prisma.shipment.findFirst({ where: { id, tenantId: tenant.id }, include: { events: { orderBy: { occurredAt: 'asc' } } } });
    if (!s) throw new NotFoundException('Shipment not found');
    return this.serialize(s);
  }

  async list(tenant: Tenant, q: ListShipmentsQuery) {
    const where: Prisma.ShipmentWhereInput = { tenantId: tenant.id };
    if (q.courier) where.courier = this.registry.parse(q.courier);
    if (q.status) {
      const st = q.status.toUpperCase();
      if (!(st in ShipmentStatus)) throw new BadRequestException(`Unknown status "${q.status}". One of: ${Object.keys(ShipmentStatus).join(', ')}`);
      where.status = st as ShipmentStatus;
    }
    if (q.orderRef) where.orderRef = q.orderRef;
    if (q.trackingNumber) where.trackingNumber = q.trackingNumber;
    if (q.from || q.to) {
      where.createdAt = {};
      if (q.from) (where.createdAt as any).gte = new Date(q.from);
      if (q.to) (where.createdAt as any).lte = new Date(q.to);
    }
    const limit = q.limit ?? 50;
    const rows = await this.prisma.shipment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => this.serialize(r));
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  // ------------------------------------------------------------------ track

  /** Track by courier + tracking number. Works for shipments booked outside this platform too. */
  async liveTrack(tenant: Tenant, courierInput: string, trackingNumber: string, accountId?: string) {
    const courier = this.registry.parse(courierInput);
    const existing = await this.prisma.shipment.findFirst({ where: { tenantId: tenant.id, courier, trackingNumber } });
    const account = await this.accounts.resolve(tenant.id, courier, accountId ?? existing?.accountId);
    const result = await this.registry.get(courier).track(this.accounts.toContext(account), trackingNumber);

    if (existing) {
      await this.applyTrackResult(existing, result);
      return { stored: true, ...(await this.get(tenant, existing.id)), live: this.liveView(result) };
    }
    return { stored: false, courier, ...this.liveView(result) };
  }

  async refresh(tenant: Tenant, id: string) {
    const s = await this.prisma.shipment.findFirst({ where: { id, tenantId: tenant.id } });
    if (!s) throw new NotFoundException('Shipment not found');
    const account = await this.accounts.get(tenant.id, s.accountId);
    const result = await this.registry.get(s.courier).track(this.accounts.toContext(account), s.trackingNumber);
    await this.applyTrackResult(s, result);
    return this.get(tenant, id);
  }

  async trackBulk(tenant: Tenant, dto: TrackBulkDto) {
    // group by courier + account so each courier gets one batched call
    type Key = string;
    const groups = new Map<Key, { courier: Courier; accountId?: string; items: { idx: number; tn: string }[] }>();
    dto.items.forEach((it, idx) => {
      const courier = this.registry.parse(it.courier);
      const key = `${courier}:${it.accountId ?? ''}`;
      if (!groups.has(key)) groups.set(key, { courier, accountId: it.accountId, items: [] });
      groups.get(key)!.items.push({ idx, tn: it.trackingNumber });
    });

    const out: any[] = new Array(dto.items.length);
    for (const g of groups.values()) {
      try {
        const account = await this.accounts.resolve(tenant.id, g.courier, g.accountId);
        const results = await this.registry.get(g.courier).trackMany(this.accounts.toContext(account), g.items.map((i) => i.tn));
        for (let i = 0; i < g.items.length; i++) {
          const r = results[i];
          const stored = await this.prisma.shipment.findFirst({ where: { tenantId: tenant.id, courier: g.courier, trackingNumber: g.items[i].tn } });
          if (stored) await this.applyTrackResult(stored, r);
          out[g.items[i].idx] = { courier: g.courier, ...this.liveView(r), stored: !!stored, shipmentId: stored?.id };
        }
      } catch (e) {
        for (const i of g.items) out[i.idx] = { courier: g.courier, trackingNumber: i.tn, error: (e as Error).message };
      }
    }
    return { results: out };
  }

  // ------------------------------------------------------------------ cancel / label

  async cancel(tenant: Tenant, id: string) {
    const s = await this.prisma.shipment.findFirst({ where: { id, tenantId: tenant.id } });
    if (!s) throw new NotFoundException('Shipment not found');
    if (s.isTerminal) throw new BadRequestException(`Shipment is already ${s.status} and cannot be cancelled`);
    const account = await this.accounts.get(tenant.id, s.accountId);
    const r = await this.registry.get(s.courier).cancel(this.accounts.toContext(account), s.trackingNumber);
    const prevStatus = s.status;
    const updated = await this.prisma.shipment.update({
      where: { id },
      data: {
        status: ShipmentStatus.CANCELLED,
        rawStatus: 'Cancelled',
        isTerminal: true,
        events: { create: [{ status: ShipmentStatus.CANCELLED, rawStatus: 'Cancelled by merchant', occurredAt: new Date() }] },
      },
    });
    await this.emitChange(updated, prevStatus);
    return { ok: r.ok, message: r.message, shipment: this.serialize(updated) };
  }

  async getLabel(tenant: Tenant, id: string): Promise<{ contentType: string; data: Buffer } | { url: string }> {
    const s = await this.prisma.shipment.findFirst({ where: { id, tenantId: tenant.id } });
    if (!s) throw new NotFoundException('Shipment not found');
    if (s.labelUrl) return { url: s.labelUrl };
    const account = await this.accounts.get(tenant.id, s.accountId);
    return this.registry.get(s.courier).getLabel(this.accounts.toContext(account), s.trackingNumber);
  }

  async paymentStatus(tenant: Tenant, id: string) {
    const s = await this.prisma.shipment.findFirst({ where: { id, tenantId: tenant.id } });
    if (!s) throw new NotFoundException('Shipment not found');
    const adapter = this.registry.get(s.courier);
    if (!adapter.getPaymentStatus) throw new BadRequestException(`${s.courier} does not expose COD payment status via API`);
    const account = await this.accounts.get(tenant.id, s.accountId);
    return adapter.getPaymentStatus(this.accounts.toContext(account), s.trackingNumber);
  }

  // ------------------------------------------------------------------ shared: apply courier data

  liveView(r: TrackResult) {
    return {
      trackingNumber: r.trackingNumber,
      found: r.found,
      status: r.status,
      rawStatus: r.rawStatus,
      deliveredAt: r.deliveredAt ?? null,
      receiverName: r.receiverName ?? null,
      events: r.events
        .slice()
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
        .map((e) => ({ status: e.status, rawStatus: e.rawStatus, at: e.occurredAt, location: e.location ?? null, note: e.note ?? null })),
    };
  }

  /** Persist tracking result: events, current status, terminal flag, unmapped-status log, outbound webhook. */
  async applyTrackResult(shipment: Shipment, result: TrackResult): Promise<Shipment> {
    const now = new Date();
    if (!result.found) {
      return this.prisma.shipment.update({ where: { id: shipment.id }, data: { lastSyncedAt: now, syncError: 'Not found at courier (yet)' } });
    }

    if (result.events.length) {
      await this.prisma.shipmentEvent.createMany({
        data: result.events.map((e) => ({
          shipmentId: shipment.id,
          status: e.status,
          rawStatus: e.rawStatus.slice(0, 500),
          location: e.location,
          note: e.note,
          occurredAt: e.occurredAt,
        })),
        skipDuplicates: true,
      });
    }

    const unknown = new Set<string>();
    for (const e of result.events) if (e.status === ShipmentStatus.UNKNOWN && e.rawStatus) unknown.add(e.rawStatus);
    if (result.status === ShipmentStatus.UNKNOWN && result.rawStatus) unknown.add(result.rawStatus);
    for (const raw of unknown) {
      await this.prisma.unmappedStatus
        .upsert({
          where: { courier_rawStatus: { courier: shipment.courier, rawStatus: raw.slice(0, 300) } },
          create: { courier: shipment.courier, rawStatus: raw.slice(0, 300) },
          update: { count: { increment: 1 }, lastSeen: now },
        })
        .catch(() => undefined);
    }

    const prev = shipment.status;
    let next = result.status;
    if (shipment.isTerminal) next = prev; // delivered / returned / cancelled are final
    if (next === ShipmentStatus.UNKNOWN) next = prev; // never regress to UNKNOWN
    const isTerminal = TERMINAL_STATUSES.includes(next);

    const updated = await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        status: next,
        rawStatus: result.rawStatus || shipment.rawStatus,
        deliveredAt: result.deliveredAt ?? shipment.deliveredAt,
        isTerminal,
        lastSyncedAt: now,
        syncError: null,
      },
    });
    if (next !== prev) await this.emitChange(updated, prev);
    return updated;
  }

  /** From a push/webhook: single event. */
  async applyWebhookEvent(shipment: Shipment, ev: { rawStatus: string; occurredAt?: Date; note?: string }) {
    const status = mapStatus(shipment.courier, ev.rawStatus).status;
    const occurredAt = ev.occurredAt ?? new Date();
    return this.applyTrackResult(shipment, {
      trackingNumber: shipment.trackingNumber,
      found: true,
      status,
      rawStatus: ev.rawStatus,
      events: [{ status, rawStatus: ev.rawStatus, occurredAt, note: ev.note }],
      deliveredAt: status === ShipmentStatus.DELIVERED ? occurredAt : undefined,
      raw: ev,
    });
  }

  private async emitChange(s: Shipment, previous: ShipmentStatus) {
    try {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: s.tenantId } });
      if (!tenant?.webhookUrl) return;
      await this.notify.enqueue({
        url: tenant.webhookUrl,
        secret: tenant.webhookSecret,
        payload: {
          event: 'shipment.status_changed',
          at: new Date().toISOString(),
          shipment: {
            id: s.id,
            courier: s.courier,
            trackingNumber: s.trackingNumber,
            orderRef: s.orderRef,
            previousStatus: previous,
            status: s.status,
            rawStatus: s.rawStatus,
            deliveredAt: s.deliveredAt,
          },
        },
      });
    } catch (e) {
      this.log.warn(`could not enqueue webhook: ${(e as Error).message}`);
    }
  }
}
