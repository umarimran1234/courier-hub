import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../src/common/crypto.service';
import { matchCity, normalizePkPhone, parseCourierDate, pick } from '../src/couriers/util';

describe('util', () => {
  it('normalizes Pakistani phones', () => {
    expect(normalizePkPhone('+92 300 1234567')).toBe('03001234567');
    expect(normalizePkPhone('0092-300-1234567')).toBe('03001234567');
    expect(normalizePkPhone('3001234567')).toBe('03001234567');
    expect(normalizePkPhone('0300-1234567')).toBe('03001234567');
  });

  it('parses courier dates (PKT -> UTC)', () => {
    expect(parseCourierDate('03/11/2026 15:30:00')?.toISOString()).toBe('2026-11-03T10:30:00.000Z');
    expect(parseCourierDate('2026-11-03', '03:30 PM')?.toISOString()).toBe('2026-11-03T10:30:00.000Z');
    expect(parseCourierDate('2026-11-03', '12:05 AM')?.toISOString()).toBe('2026-11-02T19:05:00.000Z');
    expect(parseCourierDate('2026-11-03 15:30:00')?.toISOString()).toBe('2026-11-03T10:30:00.000Z');
    expect(parseCourierDate('2026-11-03T10:30:00Z')?.toISOString()).toBe('2026-11-03T10:30:00.000Z');
    expect(parseCourierDate('garbage')).toBeUndefined();
    expect(parseCourierDate(undefined)).toBeUndefined();
  });

  it('matches cities fuzzily', () => {
    const cities = [{ name: 'Karachi' }, { name: 'Lahore' }, { name: 'Rawalpindi' }];
    expect(matchCity(cities, ' lahore ')?.name).toBe('Lahore');
    expect(matchCity(cities, 'Rawal')?.name).toBe('Rawalpindi');
    expect(matchCity(cities, 'Atlantis')).toBeUndefined();
  });

  it('pick is case-insensitive and skips empties', () => {
    expect(pick({ Status: 'x' }, 'status')).toBe('x');
    expect(pick({ a: '', b: 'y' }, 'a', 'b')).toBe('y');
  });
});

describe('crypto', () => {
  const svc = new CryptoService({ get: () => 'a'.repeat(64) } as unknown as ConfigService);
  it('round-trips credentials and uses a fresh IV', () => {
    const a = svc.encryptJson({ token: 'secret' });
    const b = svc.encryptJson({ token: 'secret' });
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret');
    expect(svc.decryptJson(a)).toEqual({ token: 'secret' });
  });
  it('detects tampering', () => {
    const enc = svc.encryptJson({ x: 1 });
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered-data').toString('base64');
    expect(() => svc.decryptJson(parts.join('.'))).toThrow();
  });
  it('hashes api keys deterministically and compares safely', () => {
    expect(CryptoService.hashApiKey('k')).toBe(CryptoService.hashApiKey('k'));
    expect(CryptoService.safeEqual('a', 'a')).toBe(true);
    expect(CryptoService.safeEqual('a', 'b')).toBe(false);
    expect(CryptoService.safeEqual('a', 'ab')).toBe(false);
  });
});
