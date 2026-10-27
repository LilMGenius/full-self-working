// Synthetic fixtures only: no value here comes from an operator instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../site/build.mjs';
import { publish } from '../scripts/publish.mjs';
import { rankPortfolio } from '../src/portfolio/rank.mjs';
import { DEFAULT_CHROME } from '../src/render/html2png.mjs';
import { tempDir } from './tmp.mjs';
import { PRIVATE, writeSiteFixture } from './fixtures/site-instance.mjs';

const { BIZ_REG_NO, PAYOUT_ACCOUNT, PHONE } = PRIVATE;
const fixture = () => writeSiteFixture(tempDir('fsw-site-test-'));

const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)).map((f) => n + '/' + f) : [n]));

test('site build from a fixture instance', { skip: !existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME) && 'Chrome not installed' }, async (t) => {
  const dir = fixture();
  const out = join(dir, 'dist');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await buildSite({ instance: dir, out });
  const ko = readFileSync(join(out, 'index.html'), 'utf8');
  const en = readFileSync(join(out, 'en', 'index.html'), 'utf8');

  await t.test('writes both languages with share image, icons, robots, sitemap and a content hash', () => {
    assert.match(ko, /<html lang="ko">/);
    assert.match(en, /<html lang="en">/);
    assert.match(ko, /작은 가게의 예약 페이지/);
    assert.match(en, /booking pages and automations/);
    for (const f of ['og.jpg', 'og-en.jpg', 'favicon.svg', 'apple-touch-icon.png', 'robots.txt', 'sitemap.xml', '404.html']) assert.ok(existsSync(join(out, f)), f);
    assert.match(readFileSync(join(out, 'sitemap.xml'), 'utf8'), /https:\/\/portfolio\.example\.org\/en\//);
    assert.equal(readFileSync(join(out, '.content-hash'), 'utf8').trim(), result.hash);
  });

  await t.test('orders gallery cards exactly as rankPortfolio returns them', () => {
    const items = JSON.parse(readFileSync(join(dir, 'portfolio', 'items.json'), 'utf8'));
    const expected = rankPortfolio(items).map((i) => i.id);
    for (const html of [ko, en]) {
      const shown = [...html.matchAll(/<li class="work-item" id="work-([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(shown, expected);
    }
    assert.ok(!expected.includes('hidden') && !expected.includes('pending'));
  });

  await t.test('never carries an em dash or a private value from the fixture', () => {
    for (const f of files(out).filter((f) => /\.(html|txt|xml|svg|json|css)$/.test(f))) {
      const text = readFileSync(join(out, f), 'utf8');
      assert.doesNotMatch(text, /[\u2014\u2015]/, f + ' holds an em dash');
      for (const value of [BIZ_REG_NO, PAYOUT_ACCOUNT, PHONE]) {
        const digits = value.replace(/\D/g, '');
        assert.doesNotMatch(text, new RegExp(digits.split('').join('[\\s.\\-]*')), f + ' holds a private value');
      }
    }
  });

  await t.test('prices come from the newest table, only for viable rows of evidenced services', () => {
    assert.match(ko, /320,000원/);
    assert.match(ko, /크몽 기준/);
    assert.match(en, /KRW 320,000/);
    assert.doesNotMatch(ko, /엑셀 매크로/);
    assert.doesNotMatch(ko, /로고/);
    assert.match(ko, /전자세금계산서 발행 가능/);
    assert.match(ko, /https:\/\/kmong\.com\/gig\/1/);
    assert.doesNotMatch(ko, /elsewhere\.example/);
  });
});

test('publish sweeps a changed build before the dry run and deploy, and skips the sweep for a deployed hash', { skip: !existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME) && 'Chrome not installed' }, async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...config, site: { ...config.site, vercelTeam: 'example-team', project: 'example-site' } }));
  const out = join(dir, 'dist');
  const swept = [];
  const deployed = [];
  const deploy = async (args) => (deployed.push(args), { url: 'https://never.example', id: 'x' });
  const failing = async (args) => (swept.push(args), { captures: ['index-320x568.jpg'], problems: ['index.html@320x568: horizontal overflow 2000 > 320 (div)'] });
  for (const dryRun of [false, true]) {
    await assert.rejects(publish({ instance: dir, out, dryRun, sweep: failing, deploy }), (err) => err.code === 'FSW_PUBLISH_SWEEP' && /1 sweep problems, first: index\.html@320x568/.test(err.message));
  }
  assert.equal(swept.length, 2);
  assert.equal(swept[0].dist, out);
  assert.match(swept[0].out, /qa[\\/]site[\\/]\d{8}$/);
  assert.deepEqual(deployed, []);
  // A clean sweep reaches the dry-run return; with that hash recorded as deployed, the sweep is never called.
  const clean = async (args) => (swept.push(args), { captures: ['index-320x568.jpg'], problems: [] });
  const dry = await publish({ instance: dir, out, dryRun: true, sweep: clean, deploy });
  assert.equal(dry.changed, true);
  mkdirSync(join(dir, 'site'), { recursive: true });
  writeFileSync(join(dir, 'site', 'last-deploy.json'), JSON.stringify({ hash: dry.hash, url: 'https://deployed.example' }));
  const before = swept.length;
  const same = await publish({ instance: dir, out, sweep: clean, deploy });
  assert.deepEqual([same.deployed, swept.length, deployed.length], [false, before, 0]);
});
