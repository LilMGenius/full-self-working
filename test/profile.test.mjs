// Synthetic background only: every name, school and number here is invented for the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDir } from '../src/core/instance.mjs';
import { run } from '../src/cli/profile.mjs';
import { checkCite, verifyDraft, buildPrompt, SERVICE_IDS } from '../src/profile/draft.mjs';
import { loadSources } from '../src/profile/sources.mjs';
import { validateProfile } from '../src/profile/validate.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'fsw-profile-'));

// A background folder: a CV, a LinkedIn-style export with a file of other people's data, and a repository.
function background() {
  const root = temp();
  writeFileSync(join(root, 'cv.md'), ['# Mina Test', 'Freelance web developer, Seoul.', 'Studio Nolan, front-end developer, 2020 to 2022', 'B.A. in Design, Hanbit University, 2014 to 2018', 'Won the Lantern Hackathon in 2021', 'Built a booking page for a bakery with Next.js', 'Worked on 3 shipped projects at Studio Nolan'].join('\n'));
  mkdirSync(join(root, 'linkedin'));
  writeFileSync(join(root, 'linkedin', 'Profile.csv'), 'First Name,Last Name,Headline\nMina,Test,Web developer\n');
  writeFileSync(join(root, 'linkedin', 'Connections.csv'), 'First Name,Last Name\nSomeone,Else\n');
  const repo = join(root, 'bookingpage');
  mkdirSync(repo);
  writeFileSync(join(repo, 'README.md'), '# bookingpage\nA booking page for small shops.\n');
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=Mina Test', '-c', 'user.email=mina@example.invalid', ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'feat: first booking form');
  return { root, repo };
}

const cite = (source, line, quote) => ({ source, line, quote });
const text = (t, ...cites) => ({ text: t, cites });
// What an honest model returns for the CV above.
const honest = (ids) => ({
  person: { nameKo: null, nameEn: 'Mina Test', handle: null, phone: null, email: null, links: [], cite: cite(ids.cv, 1, 'Mina Test') },
  headline_ko: text('', ), headline_en: text('Freelance web developer in Seoul', cite(ids.cv, 2, 'Freelance web developer, Seoul.')),
  summary_ko: text(''), summary_en: text('Built a booking page for a bakery with Next.js.', cite(ids.cv, 6, 'Built a booking page for a bakery with Next.js')),
  roles: [{ org: 'Studio Nolan', title: 'front-end developer', period: '2020 to 2022', cite: cite(ids.cv, 3, 'Studio Nolan, front-end developer, 2020 to 2022') }],
  education: [{ school: 'Hanbit University', degree: 'B.A.', field: 'Design', period: '2014 to 2018', cite: cite(ids.cv, 4, 'B.A. in Design, Hanbit University, 2014 to 2018') }],
  awards: [{ name: 'Lantern Hackathon', year: 2021, cite: cite(ids.cv, 5, 'Won the Lantern Hackathon in 2021') }],
  projects: [{ name: 'bookingpage', role: 'author', url: null, what: 'A booking page for small shops', proof: null, stack: ['Next.js'], cite: cite(ids.repo, 2, 'A booking page for small shops') }],
  skills: [{ category: 'web', name: 'Next.js' }],
  languages: [],
  serviceFit: [{ service: 'landing_page_web', strength: 'strong', evidence: ['bookingpage', 'Studio Nolan'], cite: null }, { service: 'logo_brand', strength: 'some', evidence: ['Lantern Hackathon'], cite: null }],
  approvedClaims: [{ text: '3 shipped projects', cite: cite(ids.cv, 7, 'Worked on 3 shipped projects at Studio Nolan') }],
  claimsNotToMake: [{ text: 'professional designer', reason: 'the design degree is the only design evidence' }],
  conflicts: [],
});

async function load() {
  const { root, repo } = background();
  const { sources, notes } = await loadSources([join(root, 'cv.md'), join(root, 'linkedin'), repo], { author: 'Mina Test' });
  const ids = { cv: sources.find((s) => s.label === 'cv.md').id, repo: sources.find((s) => s.label === 'bookingpage').id };
  return { root, sources, notes, ids };
}

test('sources: files, a LinkedIn folder and a repository are read; other people\'s data is not', async () => {
  const { sources, notes } = await load();
  assert.deepEqual(sources.map((s) => s.label).sort(), ['bookingpage', 'cv.md', 'linkedin/Profile.csv']);
  assert.ok(notes.some((n) => n.includes('Connections.csv') && n.includes("other people's data")));
  const repo = sources.find((s) => s.label === 'bookingpage');
  assert.ok(repo.lines.some((l) => l.includes('Mina Test: feat: first booking form')));
});

test('sources: a missing path, an unsupported file and an empty list fail by name', async () => {
  await assert.rejects(loadSources([]), { code: 'FSW_SOURCE_NONE' });
  await assert.rejects(loadSources([join(temp(), 'nope.md')]), { code: 'FSW_SOURCE_MISSING' });
  const dir = temp();
  writeFileSync(join(dir, 'cv.docx'), 'x');
  await assert.rejects(loadSources([join(dir, 'cv.docx')]), { code: 'FSW_SOURCE_UNSUPPORTED' });
});

test('sources: a URL goes through the injected fetcher and an oversize source is cut with a note', async () => {
  const r = await loadSources(['https://example.invalid/me'], { fetchText: async () => Array.from({ length: 50 }, (_, i) => 'line ' + i).join('\n'), maxCharsPerSource: 100 });
  assert.equal(r.sources[0].kind, 'url');
  assert.ok(r.sources[0].lines.length < 50);
  assert.ok(r.notes.some((n) => n.includes('only the first')));
});

test('the prompt numbers every line and lists every catalog service', async () => {
  const { sources } = await load();
  const prompt = buildPrompt(sources);
  assert.ok(prompt.includes('S1:1| '));
  for (const id of SERVICE_IDS) assert.ok(prompt.includes('- ' + id + ':'));
});

test('verifyDraft keeps cited claims and writes a valid profile', async () => {
  const { sources, ids } = await load();
  const { profile, dropped } = verifyDraft(honest(ids), sources);
  assert.deepEqual(dropped.filter((d) => !d.reason.startsWith('strength set')), []);
  assert.equal(profile.roles[0].org, 'Studio Nolan');
  assert.equal(profile.education[0].degree, 'B.A.');
  assert.deepEqual(profile.approvedClaims, ['3 shipped projects']);
  assert.deepEqual(validateProfile(profile), []);
  assert.ok(profile.provenance.every((p) => p.source && p.line > 0 && p.quote));
});

test('verifyDraft drops an invented degree, a wrong quote, an inflated number and fake evidence', async () => {
  const { sources, ids } = await load();
  const lying = honest(ids);
  lying.education.push({ school: 'Hanbit University', degree: 'M.A.', field: 'Design', period: null, cite: cite(ids.cv, 4, 'B.A. in Design, Hanbit University, 2014 to 2018') });
  lying.roles.push({ org: 'Big Corp', title: 'lead', period: '2019', cite: cite(ids.cv, 3, 'Big Corp, lead, 2019') });
  lying.approvedClaims.push({ text: '10 shipped projects', cite: cite(ids.cv, 7, 'Worked on 3 shipped projects at Studio Nolan') });
  lying.summary_en = text('Ten years of experience building booking pages.', cite(ids.cv, 6, 'Built a booking page for a bakery with Next.js'));
  lying.serviceFit.push({ service: 'web_app_dev', strength: 'strong', evidence: ['Imaginary Project'], cite: null });
  lying.awards.push({ name: 'Golden Pixel', year: 2020, cite: cite('S9', 1, 'Golden Pixel 2020') });
  const { profile, dropped } = verifyDraft(lying, sources);
  const by = (path) => dropped.find((d) => d.path.startsWith(path));
  assert.ok(by('education.1'), 'M.A. is not in its quote');
  assert.ok(by('roles.1'), 'Big Corp is not in the sources');
  assert.ok(by('approvedClaims.1'));
  assert.equal(profile.summary_en, '');
  assert.ok(by('summary_en'));
  assert.equal(profile.serviceFit.web_app_dev.strength, 'none');
  assert.ok(by('awards.1'));
  assert.deepEqual(profile.education.map((e) => e.degree), ['B.A.']);
  assert.deepEqual(profile.roles.map((r) => r.org), ['Studio Nolan']);
  assert.deepEqual(profile.approvedClaims, ['3 shipped projects']);
  assert.equal(profile.serviceFit.landing_page_web.strength, 'strong');
});

test('verifyDraft lowers strong to some on one piece of evidence and corrects a conflict to the lower value', async () => {
  const { sources, ids } = await load();
  const d = honest(ids);
  d.serviceFit[0].evidence = ['bookingpage'];
  d.conflicts = [{ field: 'Studio Nolan start', values: [{ value: '2020', number: 2020, cite: cite(ids.cv, 3, 'Studio Nolan, front-end developer, 2020 to 2022') }, { value: '2019', number: 2019, cite: cite(ids.cv, 3, 'Studio Nolan, front-end developer, 2020 to 2022') }], chosen: '2020' }];
  const { profile, conflicts } = verifyDraft(d, sources);
  assert.equal(profile.serviceFit.landing_page_web.strength, 'some');
  assert.equal(conflicts[0].chosen, '2019');
  assert.equal(conflicts[0].corrected, true);
});

test('checkCite accepts a quote one line off and rejects text that is not in the source', async () => {
  const { sources, ids } = await load();
  assert.equal(checkCite(cite(ids.cv, 5, 'Studio Nolan, front-end developer'), sources).ok, true);
  assert.equal(checkCite(cite(ids.cv, 5, 'CTO of a unicorn'), sources).ok, false);
  assert.equal(checkCite(cite('S99', 1, 'x'), sources).ok, false);
});

test('profile build writes the draft and review beside profile.json and never touches it; accept promotes the draft', async () => {
  const { root, ids } = await load();
  const inst = temp();
  for (const f of readdirSync(exampleDir)) copyFileSync(join(exampleDir, f), join(inst, f));
  const before = readFileSync(join(inst, 'profile.json'), 'utf8');
  const out = [];
  const err = [];
  const calls = [];
  const runCodex = async (opts) => {
    calls.push(opts);
    // source ids are assigned in read order, so ask the prompt for them
    const idOf = (label) => new RegExp('### (S\\d+) ' + label.replace(/[./]/g, '\\$&')).exec(opts.prompt)[1];
    return { data: honest({ cv: idOf('cv.md'), repo: idOf('bookingpage') }), durationMs: 1 };
  };
  const ctx = { instanceDir: inst, log: (l) => out.push(l), error: (l) => err.push(l), runCodex, today: '2026-01-01' };
  const code = await run(['build', join(root, 'cv.md'), join(root, 'linkedin'), join(root, 'bookingpage'), '--author', 'Mina Test', '--lang', 'ko'], ctx);
  assert.equal(code, 0, err.join('\n'));
  assert.equal(readFileSync(join(inst, 'profile.json'), 'utf8'), before);
  assert.ok(existsSync(join(inst, 'profile.draft.json')));
  const review = readFileSync(join(inst, 'profile.review.md'), 'utf8');
  assert.ok(review.includes('cv.md line 3') && review.includes('프로필 초안 검토 목록'));
  assert.equal(calls[0].schema.type, 'object');
  // a rebuild with the same answer leaves the draft file untouched
  assert.equal(await run(['build', join(root, 'cv.md'), join(root, 'bookingpage')], { ...ctx, today: '2026-02-02' }), 0);
  // accept
  assert.equal(await run(['accept'], ctx), 0, err.join('\n'));
  const accepted = JSON.parse(readFileSync(join(inst, 'profile.json'), 'utf8'));
  assert.equal(accepted.person.nameEn, 'Mina Test');
  assert.ok(readdirSync(inst).some((f) => f.startsWith('previous-profile-')));
});

test('accept refuses without a draft, with an invalid draft, and with example values', async () => {
  const inst = temp();
  for (const f of readdirSync(exampleDir)) copyFileSync(join(exampleDir, f), join(inst, f));
  const err = [];
  const ctx = { instanceDir: inst, log() {}, error: (l) => err.push(l) };
  assert.equal(await run(['accept'], ctx), 1);
  assert.match(err.pop(), /no draft/);
  writeFileSync(join(inst, 'profile.draft.json'), '{"person":{}}');
  assert.equal(await run(['accept'], ctx), 1);
  assert.match(err.pop(), /not a valid profile/);
  copyFileSync(join(exampleDir, 'profile.json'), join(inst, 'profile.draft.json'));
  assert.equal(await run(['accept'], ctx), 1);
  assert.match(err.pop(), /example values/);
});

test('build with no usable input exits 1 with a named error', async () => {
  const inst = temp();
  const err = [];
  assert.equal(await run(['build'], { instanceDir: inst, log() {}, error: (l) => err.push(l) }), 1);
  assert.match(err.join(' '), /FSW_SOURCE_NONE/);
});
