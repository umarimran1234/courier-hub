import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { AccountsService } from '../accounts/accounts.service';
import { CourierRegistry } from '../couriers/courier.registry';
import { CourierError } from '../couriers/courier.errors';
import { PrismaService } from '../prisma/prisma.service';
import { ShipmentsService } from '../shipments/shipments.service';

export const SYNC_QUEUE = 'shipment-sync';
const MAX_AGE_DAYS = 90;
const PER_ACCOUNT_BATCH = 500;

/** Registers the repeating "scan" job. */
@Injectable()
export class SyncScheduler implements OnModuleInit {
  private log = new Logger('SyncScheduler');
  constructor(@InjectQueue(SYNC_QUEUE) private q: Queue, private cfg: ConfigService) {}

  async onModuleInit() {
    if (this.cfg.get('SYNC_ENABLED') === 'false') {
      this.log.warn('Background sync disabled (SYNC_ENABLED=false)');
      return;
    }
    const minutes = Math.max(5, Number(this.cfg.get('SYNC_INTERVAL_MINUTES') ?? 30));
    await this.q.upsertJobScheduler('scan-scheduler', { every: minutes * 60_000 }, { name: 'scan', opts: { removeOnComplete: 50, removeOnFail: 200 } });
    this.log.log(`Tracking sync scheduled every ${minutes} min`);
  }
}

/**
 * scan  -> finds accounts that have in-progress shipments and fans out one "sync-account" job each
 * sync-account -> batch-tracks that account's open shipments and applies the results
 */
@Processor(SYNC_QUEUE, { concurrency: 3 })
export class SyncProcessor extends WorkerHost {
  private log = new Logger('Sync');

  constructor(
    private prisma: PrismaService,
    private registry: CourierRegistry,
    private accounts: AccountsService,
    private shipments: ShipmentsService,
    @InjectQueue(SYNC_QUEUE) private q: Queue,
    private cfg: ConfigService,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name === 'scan') return this.scan();
    if (job.name === 'sync-account') return this.syncAccount(job.data.accountId as string);
  }

  private async scan() {
    const minAgeMs = Number(this.cfg.get('SYNC_MIN_RECHECK_MINUTES') ?? 15) * 60_000;
    const rows = await this.prisma.shipment.groupBy({
      by: ['accountId'],
      where: {
        isTerminal: false,
        createdAt: { gt: new Date(Date.now() - MAX_AGE_DAYS * 86_400_000) },
        account: { active: true },
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(Date.now() - minAgeMs) } }],
      },
    });
    for (const r of rows) {
      await this.q.add('sync-account', { accountId: r.accountId }, { jobId: `sync-${r.accountId}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 100, removeOnFail: 500 });
    }
    return { accounts: rows.length };
  }

  private async syncAccount(accountId: string) {
    const acc = await this.prisma.courierAccount.findUnique({ where: { id: accountId } });
    if (!acc || !acc.active) return;
    const minAgeMs = Number(this.cfg.get('SYNC_MIN_RECHECK_MINUTES') ?? 15) * 60_000;

    const open = await this.prisma.shipment.findMany({
      where: {
        accountId,
        isTerminal: false,
        createdAt: { gt: new Date(Date.now() - MAX_AGE_DAYS * 86_400_000) },
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(Date.now() - minAgeMs) } }],
      },
      orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
      take: PER_ACCOUNT_BATCH,
    });
    if (!open.length) return { synced: 0 };

    const adapter = this.registry.get(acc.courier);
    const ctx = this.accounts.toContext(acc);
    try {
      const results = await adapter.trackMany(ctx, open.map((s) => s.trackingNumber));
      const byTn = new Map(results.map((r) => [r.trackingNumber, r]));
      let changed = 0;
      for (const s of open) {
        const r = byTn.get(s.trackingNumber);
        if (!r) continue;
        const before = s.status;
        const after = await this.shipments.applyTrackResult(s, r);
        if (after.status !== before) changed++;
      }
      this.log.log(`${acc.courier}/${acc.label}: synced ${open.length}, ${changed} changed`);
      return { synced: open.length, changed };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await this.prisma.shipment.updateMany({ where: { id: { in: open.map((s) => s.id) } }, data: { syncError: msg } });
      this.log.warn(`${acc.courier}/${acc.label}: sync failed: ${msg}`);
      // retriable courier outages -> let BullMQ retry; auth/validation errors -> don't loop
      if (e instanceof CourierError && !e.retriable) return { error: msg };
      throw e;
    }
  }
}
