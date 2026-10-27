// Synthetic fixtures only: no value here comes from an operator instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSite } from '../site/build.mjs';
import { publish } from '../scripts/publish.mjs';
import { rankPortfolio } from '../src/portfolio/rank.mjs';
import { DEFAULT_CHROME, openRenderer } from '../src/render/html2png.mjs';
import { platformFontProblems } from '../src/render/fonts.mjs';
import { repoRoot } from '../src/core/instance.mjs';
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
      const shown = [...html.matchAll(/<li class="work-item[^"]*" id="work-([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(shown, expected);
      // Many items: the first two take the wide slots and no other does.
      const wide = [...html.matchAll(/<li class="work-item([^"]*)" id="work-([^"]+)"/g)].filter((m) => /\bwide\b/.test(m[1])).map((m) => m[2]);
      assert.deepEqual(wide, expected.slice(0, 2));
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

// A fixture whose ranked portfolio is empty or holds one paid job: no background projects, and items.json set.
function sized(items) {
  const dir = fixture();
  const profile = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'));
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...profile, projects: [], serviceFit: {} }));
  writeFileSync(join(dir, 'portfolio', 'items.json'), JSON.stringify(items));
  return dir;
}

test('the gallery carries the empty, one-item and many-item states, and the pages hold no typed colour', { skip: !existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME) && 'Chrome not installed' }, async (t) => {
  const one = { id: 'only', source: 'job', title_ko: '하나뿐인 작업', title_en: 'The only job', paidAt: '2026-01-02T00:00:00Z', permission: 'granted', summary_ko: '요약', summary_en: 'Summary', url: null, media: [] };
  const dirs = [];
  t.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const build = async (items) => {
    const dir = sized(items);
    dirs.push(dir);
    await buildSite({ instance: dir, out: join(dir, 'dist') });
    return readFileSync(join(dir, 'dist', 'index.html'), 'utf8');
  };
  const empty = await build([]);
  assert.match(empty, /<section class="wrap work" id="work"/);
  assert.match(empty, /<div class="work-empty"><p>납품한 작업은 고객이 공개에 동의한 뒤/);
  assert.doesNotMatch(empty, /class="work-list/);
  assert.doesNotMatch(empty, /직접 만들었거나 기여한 프로젝트입니다/);
  const single = await build([one]);
  assert.match(single, /<ol class="work-list single">/);
  assert.equal([...single.matchAll(/<li class="work-item/g)].length, 1);
  for (const f of ['site/assets/site.css', 'site/templates/page.mjs']) assert.doesNotMatch(readFileSync(join(repoRoot, f), 'utf8'), /#[0-9a-fA-F]{3,8}\b/, f + ' types a colour');
});

test('a share card drawn in a fallback face fails the build with FSW_SITE_FONT', { skip: !existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME) && 'Chrome not installed' }, async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(buildSite({ instance: dir, out: join(dir, 'dist'), ogFontFace: '' }), (err) => err.code === 'FSW_SITE_FONT' && /og\.jpg: fallback font/.test(err.message));
  assert.ok(!existsSync(join(dir, 'dist', 'index.html')), 'a failed build leaves no output');
});

// A README capture is shown as the project's README and a contribution names the repository it went to, in both
// languages, with rankPortfolio's order kept (AGENTS.md publicClaims).
test('a README capture carries its own caption and a contribution is labelled with its repository', { skip: !existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME) && 'Chrome not installed' }, async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  mkdirSync(join(dir, 'portfolio', 'media'), { recursive: true });
  for (const f of ['rd-kit-readme.png', 'shop-screen.png', 'shop-readme.png']) writeFileSync(join(dir, 'portfolio', 'media', f), png);
  const profile = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'));
  const readme = (file, repo) => ({ kind: 'readme', src: 'media/' + file, width: 1676, height: 3200, alt: 'README of ' + repo + ' on GitHub' });
  profile.projects = [
    { name: 'R&D Kit', role: 'Author', url: 'https://github.com/yesi/rd-kit', what: 'A kit for small experiments.', media: [readme('rd-kit-readme.png', 'yesi/rd-kit')] },
    { name: 'Shop Page', role: 'Author', url: 'https://github.com/yesi/shop', what: 'A shop page.', media: [readme('shop-readme.png', 'yesi/shop'), { kind: 'image', src: 'media/shop-screen.png', width: 1440, height: 900 }] },
    { name: 'Big Lib', role: "Contributor to another maintainer's repository", url: 'https://github.com/other-org/big-lib', what: 'Fixes to a widely used library.' },
    { name: 'Private Fix', role: 'Contributor', what: 'A fix in a repository that is not public.' },
  ];
  writeFileSync(join(dir, 'profile.json'), JSON.stringify(profile));
  writeFileSync(join(dir, 'portfolio', 'items.json'), '[]');
  await buildSite({ instance: dir, out: join(dir, 'dist') });
  const ranked = rankPortfolio(JSON.parse(readFileSync(join(dir, 'portfolio', 'items.json'), 'utf8'))).map((i) => i.id);
  const pages = { ko: readFileSync(join(dir, 'dist', 'index.html'), 'utf8'), en: readFileSync(join(dir, 'dist', 'en', 'index.html'), 'utf8') };
  const card = (html, id) => html.match(new RegExp('<li class="work-item[^"]*" id="work-' + id + '">[\\s\\S]*?</li>'))[0];
  const expect = {
    ko: { readme: 'R&amp;D Kit의 GitHub README', repo: 'other-org/big-lib 저장소에 기여한 작업', other: '다른 메인테이너의 저장소에 기여한 작업' },
    en: { readme: 'README of R&amp;D Kit on GitHub', repo: 'Contribution to other-org/big-lib', other: 'Contribution to another maintainer&#39;s repository' },
  };
  for (const [lang, html] of Object.entries(pages)) {
    const e = expect[lang];
    assert.deepEqual([...html.matchAll(/<li class="work-item[^"]*" id="work-([^"]+)"/g)].map((m) => m[1]), ranked, lang + ' order');
    const rd = card(html, 'bg-r-d-kit');
    assert.match(rd, /<figure class="work-media readme"><img src="\/media\/[0-9a-f]{8}\.png" alt="([^"]+)"/);
    assert.equal(rd.match(/alt="([^"]+)"/)[1], e.readme, lang + ' alt names the README');
    assert.ok(rd.includes('<figcaption>' + e.readme + '</figcaption>'), lang + ' README caption: ' + rd);
    assert.doesNotMatch(rd, /work-kind/);
    // A screen of the running work is preferred over the README, and a screen gets no README caption.
    const shop = card(html, 'bg-shop-page');
    assert.match(shop, /<figure class="work-media"><img /);
    assert.doesNotMatch(shop, /figcaption|README/);
    assert.ok(card(html, 'bg-big-lib').includes('<p class="work-kind">' + e.repo + '</p>'), lang + ' contribution names its repository');
    assert.ok(card(html, 'bg-private-fix').includes('<p class="work-kind">' + e.other + '</p>'), lang + ' contribution without a repository');
    assert.equal([...html.matchAll(/class="work-kind"/g)].length, 2, lang + ' only the two contributions are labelled');
  }
});

// The built pages carry the floors the sweep holds (src/render/checks.mjs), and the favicon, served alone, draws its
// letter in the face it embeds rather than in a system face.
test('the built pages mark their text and tap-target floors, and the favicon draws its letter in its own face', { skip: !existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME) && 'Chrome not installed' }, async (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'dist');
  await buildSite({ instance: dir, out });
  for (const file of ['index.html', 'en/index.html']) {
    const html = readFileSync(join(out, file), 'utf8');
    assert.match(html, /<a class="mark" href="[^"]+" data-min-font="20">/, file + ' wordmark');
    const nav = html.match(/<nav [^>]*>([\s\S]*?)<\/nav>/)[1];
    const navLinks = [...nav.matchAll(/<a href="#[^"]+"([^>]*)>/g)].map((m) => m[1]);
    assert.ok(navLinks.length >= 3, file + ' nav links');
    for (const a of navLinks) assert.equal(a, ' data-min-size="24" data-min-media="(min-width: 720px)"', file + ' nav link');
    const workLinks = [...html.matchAll(/<a class="work-link"[^>]*>/g)].map((m) => m[0]);
    assert.ok(workLinks.length >= 2, file + ' work links');
    for (const a of workLinks) assert.match(a, / data-min-size="24"/);
    assert.match(html, /<a class="email" href="mailto:hello@example\.org" data-min-size="44">/, file + ' email');
    const channels = [...html.match(/<p class="channels">([\s\S]*?)<\/p>/)[1].matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    assert.equal(channels.length, 1);
    for (const a of channels) assert.match(a, / data-min-size="44"/);
  }
  const svg = readFileSync(join(out, 'favicon.svg'), 'utf8');
  assert.match(svg, /<style>@font-face\{font-family:"FSW Sans";[^}]*src:url\(data:font\/woff2;base64,/);
  assert.ok(Buffer.byteLength(svg) < 16000, 'the favicon embeds its letter, not the page subset: ' + Buffer.byteLength(svg) + ' bytes');
  const renderer = await openRenderer();
  try {
    const r = await renderer.render({ url: pathToFileURL(join(out, 'favicon.svg')).href, width: 64, height: 64, format: 'png', fontReport: true, out: join(dir, 'favicon-alone.png') });
    assert.deepEqual(platformFontProblems(r.platformFonts, 'Pretendard'), []);
  } finally {
    await renderer.close();
  }
});
