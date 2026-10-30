import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { approve, publish } from '../src/listings/gig.mjs';
import { maybeSent } from '../src/listings/watch.mjs';
import { tempDir } from './tmp.mjs';

// A kmong gig goes up only as the operator saw it: publish refuses a spec whose bytes or images differ
// from the ones fsw listings approve recorded, before it opens the listing surface.
function draftInstance() {
  const dir = tempDir('fsw-approval-');
  for (const f of ['profile.json', 'business.json', 'config.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const instance = loadInstance({ dir });
  const gig = join(dir, 'listings', 'landing_page_web');
  mkdirSync(gig, { recursive: true });
  writeFileSync(join(gig, 'spec.json'), JSON.stringify({ title: 'draft', images: { main: 'main.png', detail: ['detail-1.png'] } }));
  writeFileSync(join(gig, 'main.png'), 'main v1');
  writeFileSync(join(gig, 'detail-1.png'), 'detail v1');
  return { instance, gig };
}

function fakeSurface() {
  const calls = [];
  return { calls, adapter: { upsertListing: async (spec) => (calls.push(spec.title), { observed: true, submitted: true }), stop: async () => {} } };
}

test('publish refuses a gig the operator never approved and opens no surface', async () => {
  const { instance } = draftInstance();
  const s = fakeSurface();
  await assert.rejects(publish('landing_page_web', { instance, adapter: s.adapter, log: () => {} }), { code: 'FSW_LISTING_UNAPPROVED' });
  assert.deepEqual(s.calls, []);
});

test('an approval covers the spec and images it saw; any change asks again', async () => {
  const { instance, gig } = draftInstance();
  approve('landing_page_web', { instance });
  const spec = JSON.parse(readFileSync(join(gig, 'spec.json'), 'utf8'));
  assert.ok(JSON.parse(readFileSync(join(gig, 'approved.json'), 'utf8')).fingerprint);
  writeFileSync(join(gig, 'detail-1.png'), 'detail v2');
  const s = fakeSurface();
  await assert.rejects(publish('landing_page_web', { instance, adapter: s.adapter, log: () => {} }), { code: 'FSW_LISTING_UNAPPROVED' });
  writeFileSync(join(gig, 'detail-1.png'), 'detail v1');
  writeFileSync(join(gig, 'spec.json'), JSON.stringify({ ...spec, title: 'rewritten' }));
  await assert.rejects(publish('landing_page_web', { instance, adapter: s.adapter, log: () => {} }), { code: 'FSW_LISTING_UNAPPROVED' });
  assert.deepEqual(s.calls, []);
});

test('an unapproved publish counts as not sent to kmong review', () => {
  assert.equal(maybeSent(null, Object.assign(new Error('x'), { code: 'FSW_LISTING_UNAPPROVED' })), false);
});
