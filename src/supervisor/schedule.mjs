// The supervisor's jobs and the Seoul marks they run on (docs/DESIGN.md, Scheduling). A job is due when
// the Seoul period its newest mark opened has no recorded run, so a missed mark runs once on catch-up
// and a run inside the same period never repeats, however many ticks land in it.
import { dayKey, hourKey, nextMark, seoulParts } from '../core/clock.mjs';

const pad = (n) => String(n).padStart(2, '0');
const MINUTE = 60_000;

// every: slot5 (each 5-minute mark), hour (minute 0), day (at HH:MM), week (Monday at HH:MM).
export const JOBS = [
  // Hourly at minute 0 Seoul: supervisor self-check and the BrowserSkill keeper, ahead of the poll so a
  // restarted daemon is up before pipelines open tabs; also the login and read pass on observe platforms.
  { id: 'hourly', every: 'hour' },
  // Every 5 minutes at :00, :05 ... :55 Seoul: inbox, buyer requests and orders on draft and auto
  // platforms, because marketplaces rank sellers by response time.
  { id: 'poll', every: 'slot5' },
  // Daily at 00:00 Seoul, in this order: the day's market first, then everything priced from it.
  { id: 'market', every: 'day', at: '00:00' },
  { id: 'price', every: 'day', at: '00:00' },
  { id: 'allocation', every: 'day', at: '00:00' },
  { id: 'portfolio', every: 'day', at: '00:00' },
  { id: 'publish', every: 'day', at: '00:00' },
  { id: 'learn', every: 'day', at: '00:00' },
  // Daily at 09:00 Seoul: the operator digest, ready at the start of the workday.
  { id: 'digest', every: 'day', at: '09:00' },
  // Mondays at 00:00 Seoul: listing experiments.
  { id: 'listings', every: 'week', at: '00:00' },
];

const minutesOf = (hm) => {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + m;
};

// ISO 8601 week of a calendar date (weeks start Monday; week 1 holds the year's first Thursday).
// Date.UTC serves as a calendar here, never as the Seoul instant.
export function isoWeekKey(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}W${pad(week)}`;
}

// Key of the Seoul period whose mark is the newest at or before now. A day or week job marked at HH:MM
// shifts the instant back by HH:MM first, so 08:59 still belongs to yesterday's 09:00 period; Seoul has
// kept one offset without daylight saving since 1988, so a shift of absolute time is a wall-clock shift.
export function periodKey(job, now = new Date()) {
  const t = (now instanceof Date ? now : new Date(now)).getTime();
  if (job.every === 'slot5') return hourKey(new Date(t)) + pad(Math.floor(seoulParts(new Date(t)).minute / 5) * 5);
  if (job.every === 'hour') return hourKey(new Date(t));
  const shifted = new Date(t - minutesOf(job.at ?? '00:00') * MINUTE);
  if (job.every === 'day') return dayKey(shifted);
  if (job.every === 'week') {
    const p = seoulParts(shifted);
    return isoWeekKey(p.year, p.month, p.day);
  }
  throw new RangeError(`job ${job.id} has an unknown cadence ${job.every}`);
}

// Jobs due at now, in JOBS order, each with the period a run now would cover.
export function dueJobs(lastRuns = {}, now = new Date(), jobs = JOBS) {
  return jobs.map((job) => ({ id: job.id, period: periodKey(job, now) })).filter(({ id, period }) => lastRuns[id] !== period);
}

// The supervisor wakes on every 5-minute Seoul mark; every other mark is a multiple of it.
export const nextWake = (now = new Date()) => nextMark(now, 5);
