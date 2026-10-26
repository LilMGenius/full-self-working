// Reads the operator's background into numbered text sources for `fsw profile build`: markdown, text, CSV,
// JSON and HTML files, PDFs, URLs, a LinkedIn export folder, and local repository folders (README plus git
// history). Every source becomes a list of lines, and a claim in the draft cites a source id and a line.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { resolve } from 'node:path';

export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
  }
}

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.html', '.htm', '.rst', '.tex']);
const UNSUPPORTED_EXT = new Set(['.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.hwp', '.hwpx', '.pages', '.zip']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', '__pycache__']);
// A LinkedIn export carries other people's data next to the operator's own; those files are never read.
const OTHERS_FILES = /^(connections|messages|invitations|contacts|recommendations_(given|received)|endorsement_(given|received)_info|shares|comments|reactions)\.csv$/i;
const MAX_FILES = 60;
const MAX_TEXT_BYTES = 400_000;

const toLines = (text) => String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
}

// PDF text through poppler, then PyMuPDF; a machine with neither fails by name.
export function pdfText(file) {
  const a = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64e6 });
  if (!a.error && a.status === 0) return a.stdout;
  const py = "import sys, pymupdf; sys.stdout.reconfigure(encoding='utf-8'); print('\\n'.join(p.get_text() for p in pymupdf.open(sys.argv[1])))";
  const b = spawnSync('python', ['-c', py, file], { encoding: 'utf8', windowsHide: true, maxBuffer: 64e6 });
  if (!b.error && b.status === 0) return b.stdout;
  throw new SourceError('FSW_PDF_NO_EXTRACTOR', `cannot read ${basename(file)}: install poppler (pdftotext) or python with pymupdf, or save the PDF as text`);
}

export async function fetchPage(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'fsw-profile/1', accept: 'text/html,text/plain,*/*' } });
  if (!res.ok) throw new SourceError('FSW_URL_FAILED', `${url} answered ${res.status}; sites that need a login (LinkedIn) cannot be fetched, so export the page or save it as a file`);
  const type = res.headers.get('content-type') ?? '';
  const body = await res.text();
  return /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body) : body;
}

function gitLog(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 16e6 });
  if (r.error || r.status !== 0) throw new SourceError('FSW_GIT_FAILED', `git ${args[0]} failed in ${basename(dir)}: ${String(r.stderr || r.error?.message).trim().split(/\r?\n/)[0]}`);
  return r.stdout;
}

function repoSource(dir, label, { author, git, notes }) {
  const lines = [];
  const readme = readdirSync(dir).find((f) => /^readme(\.[a-z]+)?$/i.test(f));
  if (readme) lines.push(...toLines(readFileSync(join(dir, readme), 'utf8')).slice(0, 200));
  lines.push(`--- git history${author ? ` filtered to author "${author}"` : ''}, newest first, as: hash date author: subject ---`);
  try {
    const log = git(dir, ['log', '--no-merges', '--date=short', '--format=%h %ad %an: %s', '-n', '120', ...(author ? ['--author=' + author] : [])]);
    const commits = toLines(log).filter(Boolean);
    lines.push(...commits);
    const authors = new Set(commits.map((c) => c.replace(/^\S+ \S+ /, '').replace(/: .*$/, '')));
    if (authors.size > 1 && !author) notes.push(`${label}: ${authors.size} commit authors; pass --author "<your name>" so only your commits count as yours`);
  } catch (err) {
    if (err.code !== 'FSW_GIT_FAILED') throw err;
    notes.push(`${label}: ${err.message}; only its README is read`);
  }
  return { label, kind: 'repository', lines };
}

function fileSource(path, label, { pdf }) {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return { label, kind: 'pdf', lines: toLines(pdf(path)) };
  const raw = readFileSync(path, 'utf8');
  if (ext === '.html' || ext === '.htm') return { label, kind: 'html', lines: toLines(htmlToText(raw)) };
  return { label, kind: ext.slice(1) || 'text', lines: toLines(raw) };
}

function walk(dir, label, depth, ctx, out) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const rel = label + '/' + name;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (existsSync(join(path, '.git'))) out.push(repoSource(path, rel, ctx));
      else if (depth < 3) walk(path, rel, depth + 1, ctx, out);
      continue;
    }
    const ext = extname(name).toLowerCase();
    if (OTHERS_FILES.test(name)) {
      ctx.notes.push(`${rel}: not read, it holds other people's data`);
      continue;
    }
    if (ext !== '.pdf' && !TEXT_EXT.has(ext)) {
      if (UNSUPPORTED_EXT.has(ext)) ctx.notes.push(`${rel}: not read, ${ext} is not supported (save it as PDF, markdown or text)`);
      continue;
    }
    if (stat.size > (ext === '.pdf' ? 20_000_000 : MAX_TEXT_BYTES)) {
      ctx.notes.push(`${rel}: not read, ${stat.size} bytes is over the size limit`);
      continue;
    }
    if (out.length >= MAX_FILES) {
      ctx.notes.push(`${rel}: not read, a folder is read up to ${MAX_FILES} sources`);
      continue;
    }
    out.push(fileSource(path, rel, ctx));
  }
}

// inputs: files, folders and URLs. Returns {sources: [{id, label, kind, lines, truncatedAt}], notes}.
// Output is capped per source and in total; whatever the cap leaves out is named in notes, never silent.
export async function loadSources(inputs, { author = null, fetchText = fetchPage, pdf = pdfText, git = gitLog, maxCharsPerSource = 60_000, maxTotalChars = 240_000 } = {}) {
  if (!inputs.length) throw new SourceError('FSW_SOURCE_NONE', 'give at least one file, folder or URL');
  const notes = [];
  const ctx = { author, git, pdf, notes };
  const raw = [];
  for (const input of inputs) {
    if (/^https?:\/\//i.test(input)) {
      raw.push({ label: input, kind: 'url', lines: toLines(await fetchText(input)) });
      continue;
    }
    const path = resolve(input);
    if (!existsSync(path)) throw new SourceError('FSW_SOURCE_MISSING', `no such file or folder: ${input}`);
    const label = basename(path);
    if (statSync(path).isDirectory()) {
      if (existsSync(join(path, '.git'))) raw.push(repoSource(path, label, ctx));
      else walk(path, label, 0, ctx, raw);
    } else {
      const ext = extname(path).toLowerCase();
      if (UNSUPPORTED_EXT.has(ext)) throw new SourceError('FSW_SOURCE_UNSUPPORTED', `${label}: ${ext} is not supported; save it as PDF, markdown or text`);
      raw.push(fileSource(path, label, ctx));
    }
  }
  const sources = [];
  let total = 0;
  for (const s of raw) {
    if (!s.lines.some((l) => l.trim())) {
      notes.push(`${s.label}: empty, nothing to read`);
      continue;
    }
    if (total >= maxTotalChars) {
      notes.push(`${s.label}: not read, the total input limit of ${maxTotalChars} characters was reached`);
      continue;
    }
    const budget = Math.min(maxCharsPerSource, maxTotalChars - total);
    let used = 0;
    let keep = 0;
    while (keep < s.lines.length && used + s.lines[keep].length + 1 <= budget) used += s.lines[keep++].length + 1;
    const truncatedAt = keep < s.lines.length ? keep : null;
    if (truncatedAt !== null) notes.push(`${s.label}: only the first ${keep} of ${s.lines.length} lines were read`);
    total += used;
    sources.push({ id: 'S' + (sources.length + 1), label: s.label, kind: s.kind, lines: s.lines.slice(0, keep), truncatedAt });
  }
  if (!sources.length) throw new SourceError('FSW_SOURCE_EMPTY', 'no readable text in the given inputs' + (notes.length ? ': ' + notes.join('; ') : ''));
  return { sources, notes };
}
