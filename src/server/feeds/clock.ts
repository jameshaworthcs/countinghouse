// The UK clock the live feed keeps to: market hours and the weekday and hour of a moment in London.

/** Weekday and hour in London for a moment. */
export function londonClock(at: Date | string): { weekday: boolean; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(typeof at === 'string' ? new Date(at) : at);
  const day = parts.find((p) => p.type === 'weekday')?.value ?? '';
  return { weekday: !['Sat', 'Sun'].includes(day), hour: Number(parts.find((p) => p.type === 'hour')?.value ?? '0') };
}

/** Monday–Friday, 07:00 to 22:00 in London: when London or New York is trading. */
export function inMarketHours(at: Date): boolean {
  const { weekday, hour } = londonClock(at);
  return weekday && hour >= 7 && hour < 22;
}
