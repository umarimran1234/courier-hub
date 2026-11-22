/** Normalise a Pakistani mobile number to 03XXXXXXXXX. Returns input trimmed if it can't be normalised. */
export function normalizePkPhone(raw: string): string {
  const digits = (raw || '').replace(/[^\d+]/g, '');
  if (/^\+?92\d{10}$/.test(digits)) return '0' + digits.replace(/^\+?92/, '');
  if (/^0092\d{10}$/.test(digits)) return '0' + digits.slice(4);
  if (/^3\d{9}$/.test(digits)) return '0' + digits;
  return digits || raw.trim();
}

/**
 * Tolerant date parser for courier timestamps.
 * Handles ISO, "DD/MM/YYYY HH:mm(:ss)", "DD-MM-YYYY ...", "YYYY-MM-DD HH:mm", "Mon DD, YYYY" (+ optional separate time).
 */
export function parseCourierDate(date?: string | null, time?: string | null): Date | undefined {
  if (!date) return undefined;
  let s = String(date).trim();
  if (time) s = `${s} ${String(time).trim()}`;

  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (dmy) {
    let [, d, m, y, hh = '0', mm = '0', ss = '0', ap] = dmy;
    let h = parseInt(hh, 10);
    if (ap) {
      if (/pm/i.test(ap) && h < 12) h += 12;
      if (/am/i.test(ap) && h === 12) h = 0;
    }
    // Pakistan Standard Time (UTC+5) -> UTC
    return new Date(Date.UTC(+y, +m - 1, +d, h - 5, +mm, +ss));
  }

  const ymd = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (ymd) {
    const [, y, m, d, hh = '0', mm = '0', ss = '0', ap] = ymd;
    let h = parseInt(hh, 10);
    if (ap) {
      if (/pm/i.test(ap) && h < 12) h += 12;
      if (/am/i.test(ap) && h === 12) h = 0;
    }
    return new Date(Date.UTC(+y, +m - 1, +d, h - 5, +mm, +ss));
  }

  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t);
}

/** Fuzzy city match: exact (case/space-insensitive) then startsWith/contains. */
export function matchCity<T extends { name: string }>(cities: T[], wanted: string): T | undefined {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const w = norm(wanted);
  if (!w) return undefined;
  return (
    cities.find((c) => norm(c.name) === w) ??
    cities.find((c) => norm(c.name).startsWith(w)) ??
    cities.find((c) => w.startsWith(norm(c.name)) && norm(c.name).length >= 4)
  );
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** First defined value among candidate keys (case-insensitive). */
export function pick(obj: any, ...keys: string[]): any {
  if (!obj || typeof obj !== 'object') return undefined;
  const lower: Record<string, any> = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
  for (const k of keys) {
    const v = lower[k.toLowerCase()];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Tiny TTL cache. */
export class TtlCache<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(private ttlMs: number) {}
  get(k: string): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.m.delete(k);
      return undefined;
    }
    return e.v;
  }
  set(k: string, v: V, ttlMs = this.ttlMs) {
    this.m.set(k, { v, exp: Date.now() + ttlMs });
  }
}

/** ISO-8601 or Microsoft JSON "/Date(1546331411000+0300)/" (used by Aramex). Returns undefined if unparsable. */
export function parseIsoOrMsDate(v: unknown): Date | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const str = String(v);
  const ms = /\/Date\((-?\d+)/.exec(str);
  if (ms) return new Date(Number(ms[1]));
  const d = new Date(str);
  return isNaN(d.getTime()) ? undefined : d;
}
