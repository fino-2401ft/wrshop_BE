const DAY = 24 * 60 * 60 * 1000;

export function vnDateKey(date: Date) {
  return new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function daysUntil(due: Date, now = new Date()) {
  const start = Date.parse(`${vnDateKey(now)}T00:00:00Z`);
  const end = Date.parse(`${vnDateKey(due)}T00:00:00Z`);
  return Math.round((end - start) / DAY);
}

export function addDays(from: Date, days: number) {
  return new Date(from.getTime() + days * DAY);
}

export function parseDueDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00+07:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}
