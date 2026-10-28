// Seoul wall-clock helpers. Formatting goes through Intl with timeZone Asia/Seoul;
// mark arithmetic works in deltas from the Seoul wall clock, so no fixed offset is typed in.
export const TZ = 'Asia/Seoul';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short',
  timeZoneName: 'longOffset',
});

export const pad = (n, w = 2) => String(n).padStart(w, '0');

export function seoulParts(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '');
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    ms: d.getUTCMilliseconds(),
    weekday: p.weekday,
    offset,
  };
}

export function dayKey(date = new Date()) {
  const p = seoulParts(date);
  return `${p.year}${pad(p.month)}${pad(p.day)}`;
}

export function hourKey(date = new Date()) {
  return dayKey(date) + pad(seoulParts(date).hour);
}

export function nowSeoul(date = new Date()) {
  const p = seoulParts(date);
  const ymd = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const hm = `${pad(p.hour)}:${pad(p.minute)}`;
  return { date, iso: `${ymd}T${hm}:${pad(p.second)}.${pad(p.ms, 3)}${p.offset}`, ymd, hm };
}

// Next Seoul mark strictly after date. everyMinutes divides 60 (5, 10, 15, 30, 60) or is a
// multiple of 60 counted from 00:00 Seoul (120, 1440); 1440 is the next Seoul midnight.
export function nextMark(date, everyMinutes) {
  const every = Number(everyMinutes);
  if (!(every > 0) || !Number.isInteger(every) || (60 % every !== 0 && every % 60 !== 0)) {
    throw new RangeError(`everyMinutes must divide 60 or be a multiple of 60, got ${everyMinutes}`);
  }
  const t = (date instanceof Date ? date : new Date(date)).getTime();
  const p = seoulParts(new Date(t));
  const minuteOfDay = p.hour * 60 + p.minute;
  const midnight = t - (minuteOfDay * 60_000 + p.second * 1000 + p.ms);
  let next = Math.floor(minuteOfDay / every) * every + every;
  if (next > 1440) next = 1440;
  return new Date(midnight + next * 60_000);
}

// Minutes after midnight of an HH:MM wall-clock time.
export const toMinutes = (hm) => {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + m;
};

// True when the Seoul wall clock is in [start, end); a window whose end is before its start wraps midnight.
export function isActive(date, activeHours) {
  const [start, end] = activeHours;
  const p = seoulParts(date);
  const now = p.hour * 60 + p.minute;
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === e) return true;
  return s < e ? now >= s && now < e : now >= s || now < e;
}
