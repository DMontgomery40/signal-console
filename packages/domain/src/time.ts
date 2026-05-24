const strictYmdDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const strictIsoTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d{1,6})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function isStrictYmdDate(value: string): boolean {
  const match = strictYmdDatePattern.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcDate = new Date(Date.UTC(year, month - 1, day));

  return (
    utcDate.getUTCFullYear() === year &&
    utcDate.getUTCMonth() === month - 1 &&
    utcDate.getUTCDate() === day
  );
}

export function isStrictIsoTimestamp(value: string): boolean {
  const match = strictIsoTimestampPattern.exec(value);
  if (!match) {
    return false;
  }

  const year = match[1];
  const month = match[2];
  const day = match[3];
  if (!isStrictYmdDate(`${year}-${month}-${day}`)) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
}
