import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import axios from 'axios';
import { CryptoService } from '../common/crypto.service';

export const NOTIFY_QUEUE = 'notify';

export interface NotifyJob {
  url: string;
  secret?: string | null;
  payload: Record<string, unknown>;
}

/** Outbound webhooks to the tenant (your Shopify app / dashboard) when a shipment status changes. */
@Injectable()
export class NotifyService {
  constructor(@InjectQueue(NOTIFY_QUEUE) private q: Queue<NotifyJob>) {}

  async enqueue(job: NotifyJob) {
    await this.q.add('deliver', job, { attempts: 6, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 });
  }
}

@Processor(NOTIFY_QUEUE)
export class NotifyProcessor extends WorkerHost {
  private log = new Logger('Notify');

  async process(job: Job<NotifyJob>) {
    const { url, secret, payload } = job.data;
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'courier-hub/1' };
    if (secret) headers['x-courierhub-signature'] = CryptoService.hmac(secret, body);
    const res = await axios.post(url, body, { headers, timeout: 10_000, validateStatus: () => true });
    if (res.status >= 300) {
      this.log.warn(`webhook ${url} -> HTTP ${res.status} (attempt ${job.attemptsMade + 1})`);
      throw new Error(`Webhook responded ${res.status}`);
    }
  }
}
