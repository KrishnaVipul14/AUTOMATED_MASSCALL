export interface OperatingWindow { timezone: string; startHour: number; endHour: number; enforceInMockMode?: boolean }

/** Local hour (0-23) of `date` in the given IANA timezone. */
export function localHour(date: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(date);
  return Number(h);
}

export function isWithinWindow(date: Date, w: OperatingWindow): boolean {
  const h = localHour(date, w.timezone);
  return h >= w.startHour && h < w.endHour;
}

/** Milliseconds until the window next opens (0 if currently open). Hour-granular, max 24h. */
export function msUntilWindowOpens(date: Date, w: OperatingWindow): number {
  if (isWithinWindow(date, w)) return 0;
  for (let i = 1; i <= 24 * 60; i++) {
    const t = new Date(date.getTime() + i * 60_000);
    if (isWithinWindow(t, w)) return i * 60_000;
  }
  return 24 * 3600_000;
}
