// fsw edits soomgo [--apply] [--only intro|detail|templates]: applies the operator-approved profile text in the
// instance's platforms/soomgo-edits.json ({approved: {intro, detail, templates}, intro, detailAppend,
// templates: [{title, service, priceType, description}]}, keys starting with _ are notes). A part is saved
// only with --apply and its approved flag set, which the operator's approval sets; without --apply every
// part is typed and read back as a dry run and nothing is saved. Every text passes the outbound gate as
// kind profile first, and a template's cost is its service's base price in the newest price table, read
// at run time rather than kept in the file.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSession } from '../browser/driver.mjs';
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { gateOutbound } from '../policy/gate.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { addQuoteTemplate, appendServiceDetail, setIntro } from '../platforms/soomgo/edits.mjs';
import { latestTable } from './price.mjs';

const USAGE = 'usage: fsw edits soomgo [--apply] [--only intro|detail|templates]';
const PARTS = ['intro', 'detail', 'templates'];
const WRITERS = { setIntro, appendServiceDetail, addQuoteTemplate };

export function loadEdits(instance) {
  const file = join(instance.paths.platforms, 'soomgo-edits.json');
  if (!existsSync(file)) throw new Error(`no ${file}; write the approved intro, detail paragraph and templates there first`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const [platform, ...rest] = argv;
  const onlyAt = rest.indexOf('--only');
  const only = onlyAt >= 0 ? rest[onlyAt + 1] : null;
  if (platform !== 'soomgo' || (onlyAt >= 0 && !PARTS.includes(only))) throw new Error(USAGE);
  const apply = rest.includes('--apply');
  const instance = ctx.instance ?? loadInstance();
  const edits = loadEdits(instance);
  const descriptor = loadDescriptor('soomgo');
  const writers = { ...WRITERS, ...(ctx.writers ?? {}) };
  const rows = latestTable(instance.paths.pricing)?.table.rows ?? [];
  const gate = (text) => gateOutbound({ kind: 'profile', platform: 'soomgo', text }, { descriptor, instance });

  // Each step: [part, label, text to gate, write(session) or a reason it cannot run].
  const steps = [];
  if (edits.intro) steps.push(['intro', 'intro', edits.intro, (s) => writers.setIntro(s, edits.intro, { dryRun: !apply })]);
  if (edits.detailAppend) steps.push(['detail', 'detail paragraph', edits.detailAppend, (s) => writers.appendServiceDetail(s, edits.detailAppend, { dryRun: !apply })]);
  for (const t of edits.templates ?? []) {
    const row = rows.find((r) => r.platform === 'soomgo' && r.service === t.service);
    const write = row ? (s) => writers.addQuoteTemplate(s, { title: t.title, priceType: t.priceType, costKRW: row.baseKRW, description: t.description }, { dryRun: !apply }) : `no soomgo price row for ${t.service}`;
    steps.push(['templates', `template ${t.title}${row ? ' at ' + row.baseKRW + ' KRW' : ''}`, t.description, write]);
  }

  let failed = 0;
  let session = ctx.session ?? null;
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  try {
    for (const [part, label, text, write] of steps.filter(([part]) => !only || part === only)) {
      if (apply && edits.approved?.[part] !== true) {
        log(`${label}: not approved, left as it is`);
        continue;
      }
      const g = gate(text);
      if (!g.ok) {
        failed += 1;
        log(`${label}: refused by the gate: ${g.violations.map((v) => v.rule + ' ' + v.detail).join('; ')}`);
        continue;
      }
      if (typeof write === 'string') {
        failed += 1;
        log(`${label}: ${write}`);
        continue;
      }
      session ??= await openSession('soomgo-edits', { platform: 'soomgo', pacing: descriptor.pacing });
      try {
        const r = await write(session);
        if (!r.changed) log(`${label}: already in place`);
        else if (!apply) log(`${label}: typed and read back, then discarded (dry run)`);
        else if (r.saved) {
          log(`${label}: saved and read back`);
          ledger.addEvent({ kind: 'platform.profile_edit', platform: 'soomgo', ref: part, payload: { label } });
        } else {
          failed += 1;
          log(`${label}: saved, but the read back did not show it`);
        }
      } catch (err) {
        failed += 1;
        log(`${label}: ${err.code ? err.code + ' ' : ''}${err.message}`);
      }
    }
  } finally {
    if (session && !ctx.session) await session.stop();
    if (!ctx.ledger) ledger.close();
  }
  return failed ? 1 : 0;
}

