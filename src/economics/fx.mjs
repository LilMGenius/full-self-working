// Exchange rates for overseas market samples: the ECB euro foreign exchange reference rates as served by
// Frankfurter (https://frankfurter.dev, open source, no key), read once per Seoul day and cached in the
// instance's market directory as fx-<day>.json. The ECB publishes on TARGET working days, so a weekend
// read returns the last published date, which is kept beside the rates and beside every converted
// sample. No rate is typed into code or data: when the source cannot answer, loadFx throws
// FSW_FX_UNAVAILABLE and caches nothing, and the day's non-KRW samples are skipped by name.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayKey } from '../core/clock.mjs';
import { ensureDir } from '../core/instance.mjs';
import { EconomicsError } from './errors.mjs';

export const FX_SOURCE = 'https://api.frankfurter.dev/v1/latest?base=USD';

const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const unavailable = (detail) => new EconomicsError('FSW_FX_UNAVAILABLE', `no exchange rates from ${FX_SOURCE}: ${detail}`, { source: FX_SOURCE });

// {day, source, date, base: 'USD', rates}, where rates[X] is units of X per US dollar and USD is 1.
export async function loadFx(instance, { fetch: get = fetch, now = () => new Date() } = {}) {
  const day = dayKey(now());
  const file = join(ensureDir(instance.paths.market), `fx-${day}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  let body;
  try {
    const res = await get(FX_SOURCE, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw unavailable(err.message);
  }
  const rates = body?.rates;
  if (body?.base !== 'USD' || !/^\d{4}-\d{2}-\d{2}$/.test(body?.date ?? '') || !rates || !isPositive(rates.KRW) || !Object.values(rates).every(isPositive)) {
    throw unavailable('the answer has no USD base, publication date and positive KRW rate');
  }
  const fx = { day, source: FX_SOURCE, date: body.date, base: 'USD', rates: { ...rates, USD: 1 } };
  writeFileSync(file + '.tmp', JSON.stringify(fx, null, 2) + '\n');
  renameSync(file + '.tmp', file);
  return fx;
}

export function krwPerUnit(currency, fx) {
  if (currency === 'KRW') return 1;
  const krw = fx?.rates?.KRW;
  const unit = fx?.rates?.[currency];
  if (!isPositive(krw) || !isPositive(unit)) throw new EconomicsError('FSW_FX_MISSING', `no ${currency} to KRW rate in the rates of ${fx?.date ?? 'no date'}`, { currency });
  return krw / unit;
}

// Whole won, so a converted sample reads like a domestic one.
export const toKRW = (amount, currency, fx) => Math.round(amount * krwPerUnit(currency, fx));

// What a converted sample keeps beside its priceKRW: the currency, the rate used and where it came from.
export const fxNote = (currency, fx) => ({ currency, krwPerUnit: krwPerUnit(currency, fx), date: fx.date, source: fx.source });

// A code-set KRW price stated in a board's own currency, for a proposal priced outside KRW: rounded up to the
// step the form takes, so the converted bid never falls under the KRW price it came from.
export function foreignAmount(amountKRW, currency, fx, step = 1) {
  if (!isPositive(amountKRW)) throw new EconomicsError('FSW_FX_AMOUNT', 'no positive KRW amount to convert, got ' + amountKRW, { currency });
  if (!isPositive(step)) throw new EconomicsError('FSW_FX_AMOUNT', 'the rounding step must be positive, got ' + step, { currency });
  const units = amountKRW / krwPerUnit(currency, fx);
  return Number((Math.ceil(units / step - 1e-9) * step).toFixed(2));
}
