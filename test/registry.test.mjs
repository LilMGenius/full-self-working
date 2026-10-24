import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listDescriptors, loadDescriptor, validateDescriptor } from '../src/platforms/registry.mjs';

test('every descriptor loads and validates', () => {
  assert.deepEqual(listDescriptors(), ['fiverr', 'freelancer', 'kmong', 'soomgo', 'upwork', 'wishket']);
  for (const id of listDescriptors()) assert.equal(loadDescriptor(id).id, id);
});

test('kmong and soomgo carry the verified money rules', () => {
  const k = loadDescriptor('kmong');
  assert.deepEqual(k.fees.seller.map((t) => t.rate), [0.164, 0.094, 0.044]);
  assert.equal(k.offPlatformPayment, false);
  assert.equal(k.milestones, 'reorder');
  const s = loadDescriptor('soomgo');
  assert.equal(s.offPlatformPayment, true);
  assert.equal(s.milestones, 'multi_pay');
});

test('a descriptor missing a required path throws FSW_DESCRIPTOR_INVALID naming it', () => {
  const broken = structuredClone(loadDescriptor('kmong'));
  delete broken.pacing.minGapMs;
  assert.throws(() => validateDescriptor(broken, 'kmong'), (e) => e.code === 'FSW_DESCRIPTOR_INVALID' && e.path === 'pacing.minGapMs');
  assert.throws(() => loadDescriptor('nope'), (e) => e.code === 'FSW_DESCRIPTOR_INVALID');
});
