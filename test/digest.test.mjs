// Synthetic instance and summary only: no figure here comes from an operator instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { writeDigest } from '../src/supervisor/digest.mjs';

function instanceWith(summary) {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-digest-'));
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  if (summary) {
    mkdirSync(join(dir, 'market'));
    writeFileSync(join(dir, 'market', 'summary-20261025.json'), JSON.stringify(summary));
  }
  return loadInstance({ dir });
}

const digestText = async (instance) => {
  const d = await writeDigest({ instance, ledger: openLedger(':memory:'), now: new Date('2026-10-26T00:00:00Z'), notify: async () => ({ written: true }) });
  return readFileSync(d.file, 'utf8');
};

test('the digest lists each service\'s market on every sampled platform, saying what each figure measures', async () => {
  const text = await digestText(instanceWith([
    { platform: 'kmong', category: '로고 디자인', n: 30, p25: 30000, median: 57000, p75: 90000 },
    { platform: 'soomgo', category: '로고 디자인', n: 117808, minKRW: 50000, p25: null, median: null, p75: null, maxKRW: 300000, avgKRW: 100000 },
    { platform: 'freelancer', category: 'Logo Design', n: 30, p25: 66000, median: 185000, p75: 330000 },
    { platform: 'wishket', category: '랜딩ㆍ소개 페이지', n: 18, p25: 2000000, median: 4000000, p75: 8000000 },
  ]));
  assert.match(text, /## Market medians\n\n- from summary-20261025\.json\n/);
  assert.match(text, /- logo_brand: kmong 57,000 KRW from price \(n 30\), soomgo 100,000 KRW guide avg, freelancer 185,000 KRW budget \(n 30\)\n/);
  assert.match(text, /- landing_page_web: wishket 4,000,000 KRW budget \(n 18\)\n/);
  assert.doesNotMatch(text, /- web_app_dev:/);
});

test('the digest prints none for the market until a summary exists', async () => {
  assert.match(await digestText(instanceWith(null)), /## Market medians\n\n- none\n/);
});
