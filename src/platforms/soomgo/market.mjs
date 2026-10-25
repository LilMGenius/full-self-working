// 숨고 market sampling: the public price guide at /prices/<slug> for each service's soomgoGuide label.
// Slugs are irregular (사진-편집보정, 매크로vba-개발), so every run reads them from the guide index by
// exact link text instead of keeping a copy here.
import { toInt } from '../kit.mjs';

const BASE = 'https://soomgo.com';

const pageIndex = () => [...document.querySelectorAll('a[href*="/prices/"]')].map((a) => [a.innerText.trim(), a.getAttribute('href')]);
const pageText = () => document.body.innerText;

// Amounts as the guide prints them: "7만 5천원" is 75,000 and "1억 2000만원" 120,000,000; text with no
// unit reads as plain digits.
export function koreanAmount(text) {
  const s = String(text ?? '').replace(/,/g, '');
  const part = (re, factor) => Number(s.match(re)?.[1] ?? 0) * factor;
  const value = part(/(\d+(?:\.\d+)?)\s*억/, 1e8) + part(/(\d+(?:\.\d+)?)\s*만/, 1e4) + part(/(\d+)\s*천/, 1e3) + part(/(\d+)\s*백/, 1e2);
  return value ? Math.round(value) : toInt(s);
}

// The guide prints each figure twice: a label line in Korean units (평균 / 7만) and a sentence in digits
// (평균 비용은 건당 79,000원이에요). The lines round, so the sentence wins and a line stands in only for
// a figure the sentence lacks. The unit (건, 장) is kept, since a per-sheet average is not a job price.
// A lesson guide (프로그래밍/코딩 레슨) prints only an hourly average and no 최저 or 최고 at all; its
// minimum and maximum are null, and a guide that names them but cannot be read still fails.
export function parseGuide(text) {
  const t = String(text ?? '');
  const figure = (lead) => {
    const sentence = t.match(new RegExp(`${lead} (?:비용|금액)은\\s*(?:\\S+당\\s*)?([\\d,]+)원`));
    if (sentence) return toInt(sentence[1]);
    const line = t.match(new RegExp(`(?:^|\\n)${lead}\\s*\\n\\s*([^\\n]+)`));
    return line ? koreanAmount(line[1]) : null;
  };
  const [avgKRW, minKRW, maxKRW] = [figure('평균'), figure('최저'), figure('최(?:고|대)')];
  const averageOnly = avgKRW != null && !/최저|최고|최대/.test(t);
  if (avgKRW == null || ((minKRW == null || maxKRW == null) && !averageOnly)) throw new Error('price guide figures not found');
  return {
    avgKRW,
    minKRW,
    maxKRW,
    unit: t.match(/평균 (?:비용|금액)은\s*(\S+)당/)?.[1] ?? null,
    quoteRequests: toInt(t.match(/누적 견적요청\s*([\d,]+)건/)?.[1]),
    activePros: toInt(t.match(/활동고수\s*([\d,]+)명/)?.[1]),
  };
}

export async function sample(session, targets, { now = () => new Date() } = {}) {
  await session.navigate(`${BASE}/prices`, { settle: 3000 });
  const index = new Map(await session.evaluate(pageIndex));
  const rows = [];
  const errors = [];
  for (const { category } of targets) {
    try {
      const href = index.get(category);
      if (!href) throw new Error(`no guide link named ${category} on ${BASE}/prices`);
      const url = new URL(href, BASE).href;
      await session.navigate(url, { settle: 3000 });
      rows.push({ platform: 'soomgo', category, url, guide: parseGuide(await session.evaluate(pageText)), observedAt: now().toISOString() });
    } catch (err) {
      errors.push({ category, message: err.message });
    }
  }
  return { rows, errors };
}
