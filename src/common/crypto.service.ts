import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(cfg: ConfigService) {
    const raw = cfg.get<string>('ENCRYPTION_KEY') ?? '';
    // Accept 64 hex chars or any string (hashed to 32 bytes). A real random key is strongly recommended.
    this.key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : createHash('sha256').update(raw || 'dev-only-insecure-key').digest();
  }

  encryptJson(obj: unknown): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
  }

  decryptJson<T = any>(payload: string): T {
    const [v, iv, tag, data] = payload.split('.');
    if (v !== 'v1') throw new Error('Unsupported ciphertext version');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    const dec = Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]);
    return JSON.parse(dec.toString('utf8'));
  }

  static hashApiKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  static randomApiKey(): string {
    return 'chk_' + randomBytes(24).toString('hex');
  }

  static hmac(secret: string, body: string): string {
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  static safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }
}
