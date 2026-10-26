#!/usr/bin/env node
// The rehearsal's effect check (003 "Verifier and recovery scripts"; 050 2.2, A4). --mark writes the
// copy's boundary (max id of events, messages and quotes, and the time) before the first rehearsal tick;
// --since-mark then reads only rows after it and requires exactly --ticks supervisor.tick events, each
// forced to observe, and no outbound effect. Raw tables are read on a read-only connection; outbox rows
// come through the ledger's own listOutbox (003 Ledger v4), and a copy below version 4 has no outbox.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openLedger } from '../src/core/ledger.mjs';

const TABLES = ['events', 'messages', 'quotes'];
// Events that are an outbound or a write to a platform: a listing, a profile or career edit, service
// items, an identity request, an onboarding step, a proposal, a sent message or quote (the 2c77326
// pipeline's names), a changed setting. A phase that adds a platform write adds its kind here.
export const EFFECT_EVENTS = ['listing.publish', 'platform.profile_edit', 'platform.service_items', 'platform.identity_request', 'platform.onboarding', 'project.proposed', 'message.sent', 'quote.sent', 'settings.changed'];
export const SENT_STATUSES = ['sending', 'observed', 'unobserved'];

// Pure: findings for the rows after a mark.
export function effects({ ticks, events, messagesOut, quotes, outboxMoves }, expectedTicks) {
  const f = [];
  if (ticks.length !== expectedTicks) f.push(ticks.length + ' supervisor.tick events after the mark, expected ' + expectedTicks);
  for (const t of ticks) if (t.forceMode !== 'observe') f.push('a tick at ' + t.at + ' ran with forceMode ' + t.forceMode);
  for (const e of events) {
    if (EFFECT_EVENTS.includes(e.kind)) f.push('outbound event ' + e.kind + ' at ' + e.at);
    if (e.kind === 'listing.refresh' && (e.payload?.rows ?? []).some((r) => r.result?.submitted)) f.push('a submitted listing.refresh at ' + e.at);
    if (e.kind === 'outbox.status' && SENT_STATUSES.includes(e.payload?.to)) f.push('an outbox row moved to ' + e.payload.to + ' at ' + e.at);
  }
  if (messagesOut) f.push(messagesOut + ' new outbound messages');
  if (quotes) f.push(quotes + ' new quotes');
  for (const r of outboxMoves) f.push('outbox row ' + r.id + ' is ' + r.status + ' after the mark');
  return f;
}

export function mark(ledger, at = new Date()) {
  const db = new DatabaseSync(ledger, { readOnly: true });
  try {
    return { at: at.toISOString(), ...Object.fromEntries(TABLES.map((t) => [t, db.prepare('SELECT coalesce(max(id), 0) AS m FROM ' + t).get().m])) };
  } finally {
    db.close();
  }
}

// The rows after a mark, in the shape effects() reads.
export function sinceMark(ledger, m) {
  const db = new DatabaseSync(ledger, { readOnly: true });
  let events, messagesOut, quotes, version;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    version = db.prepare('PRAGMA user_version').get().user_version;
    events = db.prepare('SELECT id, kind, at, payload FROM events WHERE id > ? ORDER BY id').all(m.events).map((e) => ({ ...e, payload: JSON.parse(e.payload ?? 'null') }));
    messagesOut = db.prepare("SELECT count(*) AS n FROM messages WHERE id > ? AND direction = 'out'").get(m.messages).n;
    quotes = db.prepare('SELECT count(*) AS n FROM quotes WHERE id > ?').get(m.quotes).n;
  } finally {
    db.close();
  }
  const ticks = events.filter((e) => e.kind === 'supervisor.tick').map((e) => ({ at: e.at, forceMode: e.payload?.forceMode ?? null }));
  let outboxMoves = [];
  if (version >= 4) {
    const l = openLedger(ledger);
    try {
      outboxMoves = l.listOutbox({ statuses: SENT_STATUSES }).filter((r) => r.updatedAt > m.at);
    } finally {
      l.close();
    }
  }
  return { ticks, events, messagesOut, quotes, outboxMoves };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const { values: a } = parseArgs({ options: { ledger: { type: 'string' }, mark: { type: 'string' }, 'since-mark': { type: 'string' }, ticks: { type: 'string' } } });
  if (!a.ledger || !(a.mark || (a['since-mark'] && a.ticks != null))) {
    console.error('usage: rehearsal-effects.mjs --ledger <copy> --mark <file> | --ledger <copy> --since-mark <file> --ticks <n>');
    process.exit(2);
  }
  if (a.mark) {
    const m = mark(a.ledger);
    writeFileSync(a.mark, JSON.stringify(m) + '\n');
    console.log(JSON.stringify(m));
    process.exit(0);
  }
  const rows = sinceMark(a.ledger, JSON.parse(readFileSync(a['since-mark'], 'utf8')));
  const f = effects(rows, Number(a.ticks));
  for (const x of f) console.log(x);
  console.log(JSON.stringify({ ticks: rows.ticks.length, events: rows.events.length, messagesOut: rows.messagesOut, quotes: rows.quotes, outboxMoves: rows.outboxMoves.length, findings: f.length }));
  console.log('findings: ' + f.length);
  process.exit(f.length ? 1 : 0);
}
