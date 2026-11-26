const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function getTodayDateString(): string {
  const now = new Date();
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isValidDateStr(str: string): boolean {
  const m = DATE_RE.exec(str);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

export function shiftDate(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const year = String(dt.getUTCFullYear()).padStart(4, '0');
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function shiftMonth(monthStr: string, deltaMonths: number): string {
  const [y, m] = monthStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  const year = String(dt.getUTCFullYear()).padStart(4, '0');
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function formatHeaderDate(dateStr: string, todayStr: string, compact = false): string {
  if (!isValidDateStr(dateStr)) return dateStr;
  const [y, m, d] = dateStr.split('-').map(Number);
  const localDt = new Date(y, m - 1, d);
  const weekday = WEEKDAYS_ZH[localDt.getDay()];
  const currentYear = todayStr.slice(0, 4);
  if (compact && dateStr.slice(0, 4) === currentYear) {
    return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${weekday}`;
  }
  return `${dateStr} ${weekday}`;
}

export function formatMonthHeading(monthStr: string): string {
  const [y, m] = monthStr.split('-').map(Number);
  return `${y}年${m}月`;
}

export function formatTimeShort(isoStr: string | null): string {
  if (!isoStr) return '';
  const dt = new Date(isoStr);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTimeCompact(isoStr: string | null): string {
  if (!isoStr) return '';
  const dt = new Date(isoStr);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface CalendarCell {
  date: string;
  dayNumber: number;
  inCurrentMonth: boolean;
}

/**
 * Build a 7-column Monday-start calendar grid for YYYY-MM.
 */
export function buildMonthGrid(monthStr: string): CalendarCell[] {
  const [y, m] = monthStr.split('-').map(Number);
  const firstDay = new Date(y, m - 1, 1);
  // Convert Sun=0..Sat=6 to Mon=0..Sun=6
  const startOffset = (firstDay.getDay() + 6) % 7;
  const gridStartDate = shiftDate(`${monthStr}-01`, -startOffset);
  const daysInMonth = new Date(y, m, 0).getDate();
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  const cells: CalendarCell[] = [];
  for (let i = 0; i < totalCells; i++) {
    const date = shiftDate(gridStartDate, i);
    cells.push({
      date,
      dayNumber: Number(date.slice(-2)),
      inCurrentMonth: date.slice(0, 7) === monthStr,
    });
  }
  return cells;
}
