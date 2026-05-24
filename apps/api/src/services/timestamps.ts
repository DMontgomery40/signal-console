const STRICT_ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?([Zz]|[+-]\d{2}:\d{2}))?$/;

export interface StrictIsoTimestampOptions {
  readonly requireExplicitTimezone?: boolean;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  if (month >= 1 && month <= 12) return 31;
  return 0;
}

function readInt(raw: string | undefined): number {
  return Number.parseInt(raw ?? "0", 10);
}

export function parseStrictIsoTimestamp(
  input: string,
  options: StrictIsoTimestampOptions = {},
): number | null {
  const trimmed = input.trim();
  const match = STRICT_ISO_TIMESTAMP_RE.exec(trimmed);
  if (match === null) return null;

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , zoneRaw] = match;
  const year = readInt(yearRaw);
  const month = readInt(monthRaw);
  const day = readInt(dayRaw);
  if (day < 1 || day > daysInMonth(year, month)) return null;

  const hasTime = hourRaw !== undefined;
  if (options.requireExplicitTimezone === true && zoneRaw === undefined) return null;
  if (hasTime && zoneRaw === undefined) return null;

  if (hasTime) {
    const hour = readInt(hourRaw);
    const minute = readInt(minuteRaw);
    const second = readInt(secondRaw);
    if (hour > 23 || minute > 59 || second > 59) return null;
  }

  if (zoneRaw !== undefined && zoneRaw.toUpperCase() !== "Z") {
    const offsetHour = Number.parseInt(zoneRaw.slice(1, 3), 10);
    const offsetMinute = Number.parseInt(zoneRaw.slice(4, 6), 10);
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
