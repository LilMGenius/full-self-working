import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildResume, checkResume, formatPeriod, resumeHtml, resumeLines, resumeModel } from '../src/profile/resume.mjs';
import { fontProblems, pdfFonts, pdfPageCount, platformFontProblems } from '../src/render/fonts.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { run } from '../src/cli/profile.mjs';

// A synthetic operator: English facts with Korean renderings on some entries, links and a handle that
// must never print, one contribution to someone else's project.
const PROFILE = {
  person: { nameKo: '김예시', nameEn: 'Yesi Kim', handle: 'yesi', links: ['https://example.com/yesi'] },
  headline_ko: '웹과 자동화를 만드는 개발자',
  headline_en: 'Developer who builds web apps',
  summary_ko: '랜딩 페이지와 업무 자동화를 기획부터 배포까지 맡습니다.',
  summary_en: 'Builds landing pages and automations.',
  roles: [
    { org: 'Sample Studio', org_ko: '샘플 스튜디오', title: 'Founder', title_ko: '대표', period: '2024.03 to present' },
    { org: 'Old Corp', title: 'Engineer', period: '2021.01 to 2023.12' },
  ],
  projects: [
    { name: 'shop-site', name_ko: '쇼핑몰 사이트', role: 'Author', role_ko: '저자', what: 'A shop.', what_ko: '작은 쇼핑몰입니다.', url: 'https://shop.example.com', proof: 'Repository yesi/shop-site', stack: ['Node.js'] },
    { name: 'big-harness', role: 'Contributor to another maintainer\'s repository', what: 'An agent harness.', url: 'https://example.org/big', stack: ['TypeScript'] },
  ],
  awards: [{ name: 'Sample Jam, 1st place', name_ko: '샘플 잼 1위', year: 2023 }],
  education: [{ school: 'Sample University', school_ko: '예시대학교', field: 'Design', degree: 'No degree completed', degree_ko: '중퇴', period: '2019.03 to 2019.08' }],
  skills: { web: ['Static sites'], ai: ['RAG'] },
  skills_ko: { web: ['정적 사이트'], ai: ['RAG'] },
  languages: ['Korean (native)'],
  languages_ko: ['한국어 (모국어)'],
  approvedClaims: [],
  claimsNotToMake: [],
};

const instanceAt = (dir, profile = PROFILE) => ({ dir, profile, business: {}, config: {} });
const temp = () => mkdtempSync(join(tmpdir(), 'fsw-resume-'));
const FAKE_PDF = '%PDF-1.4\n1 0 obj << /Type /Pages /Count 1 >> endobj\n2 0 obj << /Type /Page /Parent 1 0 R >> endobj\n3 0 obj << /Type /Font /Subtype /Type3 >> endobj\n%%EOF\n';

function fakeRenderer({ platformFonts = [{ familyName: 'Pretendard Variable', isCustomFont: true, glyphCount: 120 }], pdf = FAKE_PDF } = {}) {
  const calls = { pdf: 0 };
  const open = async () => ({
    async pdf({ out }) {
      calls.pdf += 1;
      writeFileSync(out, pdf);
      return { out, platformFonts };
    },
    close: async () => {},
  });
  return { open, calls };
}

test('the resume prints Korean renderings where an entry has them and English otherwise, never links or handles', () => {
  const m = resumeModel(PROFILE, { lang: 'ko' });
  assert.equal(m.name, '김예시');
  assert.equal(m.altName, 'Yesi Kim');
  assert.deepEqual(m.roles.map((r) => [r.org, r.title, r.period]), [['샘플 스튜디오', '대표', '2024.03 ~ 현재'], ['Old Corp', 'Engineer', '2021.01 ~ 2023.12']]);
  assert.deepEqual(m.projects.map((x) => x.name), ['쇼핑몰 사이트']);
  assert.deepEqual(m.contributions.map((x) => x.name), ['big-harness']);
  assert.deepEqual(m.skills, [{ group: '웹', items: ['정적 사이트'] }, { group: 'AI', items: ['RAG'] }]);
  const printed = resumeLines(m).join('\n') + resumeHtml(m, { fontFace: '' });
  for (const hidden of ['example.com', 'example.org', 'yesi/shop-site', 'https://']) assert.ok(!printed.includes(hidden), hidden + ' printed');
  assert.equal(resumeModel(PROFILE, { lang: 'en' }).roles[0].title, 'Founder');
  assert.equal(formatPeriod('2019.03 to 2019.08'), '2019.03 ~ 2019.08');
});

test('a domain or an e-mail in a printed field fails the platform gate', () => {
  const descriptor = loadDescriptor('kmong');
  const leaky = { ...PROFILE, projects: [{ ...PROFILE.projects[0], name_ko: 'shop.example.com 쇼핑몰' }], summary_ko: '문의는 yesi@example.com 으로 주세요.' };
  const gate = checkResume(resumeModel(leaky), { instance: instanceAt('.', leaky), descriptor });
  assert.equal(gate.ok, false);
  assert.deepEqual([...new Set(gate.violations.map((v) => v.rule))].sort(), ['contact.email', 'contact.url']);
  assert.equal(checkResume(resumeModel(PROFILE), { instance: instanceAt('.'), descriptor }).ok, true);
});

test('the PDF is written only when the renderer drew every glyph in the inlined face, and an unchanged page is not printed again', async () => {
  const dir = temp();
  try {
    const out = join(dir, 'documents', 'resume-ko.pdf');
    const bad = fakeRenderer({ platformFonts: [{ familyName: 'Pretendard Variable', isCustomFont: true, glyphCount: 90 }, { familyName: 'Malgun Gothic', isCustomFont: false, glyphCount: 3 }] });
    await assert.rejects(buildResume({ instance: instanceAt(dir), out, openRenderer: bad.open }), (err) => err.code === 'FSW_RESUME_PRINT' && /Malgun Gothic/.test(err.message));
    assert.equal(existsSync(out), false);
    const good = fakeRenderer();
    const first = await buildResume({ instance: instanceAt(dir), out, openRenderer: good.open });
    assert.deepEqual([first.unchanged, first.pages, readFileSync(out, 'utf8')], [false, 1, FAKE_PDF]);
    const again = await buildResume({ instance: instanceAt(dir), out, openRenderer: good.open });
    assert.deepEqual([again.unchanged, good.calls.pdf], [true, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a leaking profile stops before anything is printed', async () => {
  const dir = temp();
  try {
    const r = fakeRenderer();
    const leaky = { ...PROFILE, headline_ko: '연락은 010-1234-5678' };
    await assert.rejects(buildResume({ instance: instanceAt(dir, leaky), openRenderer: r.open }), (err) => err.code === 'FSW_RESUME_GATE' && /contact\.phone/.test(err.message));
    assert.equal(r.calls.pdf, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('embedded fonts outside the family and renderer fallbacks are named; Type3 glyphs alone pass', () => {
  const bytes = Buffer.from('<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+MalgunGothic >> << /Type /Font /Subtype /Type3 >> << /Type /Page >> << /Type /Pages >>', 'latin1');
  const fonts = pdfFonts(bytes);
  assert.deepEqual(fonts, { named: ['MalgunGothic'], type3: 1 });
  assert.equal(pdfPageCount(bytes), 1);
  assert.deepEqual(fontProblems(fonts, 'Pretendard'), ['fallback font MalgunGothic in the PDF']);
  assert.deepEqual(fontProblems({ named: ['Pretendard-Bold'], type3: 4 }, 'Pretendard'), []);
  assert.deepEqual(fontProblems({ named: [], type3: 0 }, 'Pretendard'), ['the PDF embeds no font']);
  assert.deepEqual(platformFontProblems([{ familyName: 'Segoe UI Emoji', isCustomFont: false, glyphCount: 1 }], 'Pretendard'), ['fallback font Segoe UI Emoji drew 1 glyphs']);
  assert.deepEqual(platformFontProblems([], 'Pretendard'), ['the renderer reported no fonts for the text']);
});

test('fsw profile resume writes the PDF into the instance and reports a gate refusal by code', async () => {
  const dir = temp();
  try {
    const logs = [];
    const errors = [];
    const ok = await run(['resume'], { instance: instanceAt(dir), openRenderer: fakeRenderer().open, log: (l) => logs.push(l), error: (l) => errors.push(l) });
    assert.equal(ok, 0);
    assert.ok(existsSync(join(dir, 'documents', 'resume-ko.pdf')));
    assert.match(logs[0], /^wrote .*resume-ko\.pdf \(1 page\)/);
    const refused = await run(['resume'], { instance: instanceAt(dir, { ...PROFILE, summary_ko: 'https://example.com 참고' }), openRenderer: fakeRenderer().open, log: () => {}, error: (l) => errors.push(l) });
    assert.equal(refused, 1);
    assert.match(errors.at(-1), /FSW_RESUME_GATE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

