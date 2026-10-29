/**
 * Time source of the economy. The daily mission day key comes from here:
 * offline it is the browser's local calendar date; an online build swaps in
 * a clock whose day key comes from the server (never the client's clock).
 */
export interface EconomyClock {
  /** ISO timestamp for records. */
  nowIso(): string;
  /** Mission day ("YYYY-MM-DD"). */
  dayKey(): string;
}

/** Local build: the device's own date (a changed device clock changes the day; acceptable offline, not online). */
export class LocalClock implements EconomyClock {
  nowIso(): string {
    return new Date().toISOString();
  }

  dayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}

/** A clock set by hand (tests, or a server-provided day). */
export class FixedClock implements EconomyClock {
  constructor(
    public day: string,
    public iso = `${day}T12:00:00.000Z`,
  ) {}

  nowIso(): string {
    return this.iso;
  }

  dayKey(): string {
    return this.day;
  }
}
