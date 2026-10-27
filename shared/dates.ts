// 'YYYY-MM-DD' 形式の日付ユーティリティ（タイムゾーンの影響を受けないよう UTC で計算する）

export function ymdToDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function dateToYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(ymd: string, days: number): string {
  const d = ymdToDate(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return dateToYmd(d);
}

/** その日を含む週の月曜日 */
export function mondayOf(ymd: string): string {
  const d = ymdToDate(ymd);
  const dow = (d.getUTCDay() + 6) % 7; // 月=0
  return addDays(ymd, -dow);
}

/** 指定タイムゾーン（既定: 日本時間）での今日 */
export function todayYmd(offsetMinutes = 540, now = Date.now()): string {
  return dateToYmd(new Date(now + offsetMinutes * 60_000));
}

export function diffDays(a: string, b: string): number {
  return Math.round((ymdToDate(b).getTime() - ymdToDate(a).getTime()) / 86_400_000);
}

export function isValidYmd(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = ymdToDate(s);
  return !Number.isNaN(d.getTime()) && dateToYmd(d) === s;
}
