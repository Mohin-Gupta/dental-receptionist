export function normalizeTime(t: string): string {
  const cleaned = t.trim().toUpperCase();
  if (cleaned.includes('AM') || cleaned.includes('PM')) {
    const parts = cleaned.split(' ');
    const timePart = parts[0];
    const period = parts[1];
    const [hStr, mStr] = timePart.split(':');
    let h = parseInt(hStr, 10);
    const m = mStr ? parseInt(mStr, 10) : 0;
    if (period === 'AM' && h === 12) h = 0;
    if (period === 'PM' && h !== 12) h += 12;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }
  const [hStr, mStr] = t.split(':');
  return `${parseInt(hStr, 10).toString().padStart(2, '0')}:${parseInt(mStr ?? '0', 10).toString().padStart(2, '0')}`;
}

export function toReadableTime(h: number, m: number): string {
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minuteStr = m === 0 ? '' : `:${m.toString().padStart(2, '0')}`;
  return `${hour12}${minuteStr} ${period}`;
}

export function toReadableDate(dateStr: string): string {
  const monthNames = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  const [, month, day] = dateStr.split('-').map(Number);
  return `${monthNames[month - 1]} ${day}`;
}

export function utcToISTReadable(utcDate: Date): {
  readableDate: string;
  readableTime: string;
} {
  const istMs = utcDate.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const monthNames = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  return {
    readableDate: `${monthNames[ist.getUTCMonth()]} ${ist.getUTCDate()}`,
    readableTime: toReadableTime(h, m),
  };
}