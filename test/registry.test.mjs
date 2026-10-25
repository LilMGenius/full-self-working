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

test('wishket and freelancer carry fees from their official pages, so their markets can be priced', async () => {
  const { sellerNet } = await import('../src/economics/fees.mjs');
  // The price page's example: a 10,000,000 KRW project leaves the partner 8,000,000 before VAT.
  assert.equal(sellerNet(10000000, loadDescriptor('wishket')).net, 8000000);
  assert.equal(sellerNet(1000000, loadDescriptor('wishket')).net, 750000);
  assert.equal(sellerNet(1000000, loadDescriptor('freelancer')).net, 900000);
});

test('whole-amount tiers must never raise the rate, and an unknown tier basis is refused', () => {
  const rising = structuredClone(loadDescriptor('wishket'));
  rising.fees.seller = [{ uptoKRW: 5000000, rate: 0.2 }, { uptoKRW: null, rate: 0.25 }];
  assert.throws(() => validateDescriptor(rising, 'wishket'), (e) => e.code === 'FSW_DESCRIPTOR_INVALID' && e.path === 'fees.seller');
  const odd = structuredClone(loadDescriptor('wishket'));
  odd.fees.sellerTierBasis = 'flat';
  assert.throws(() => validateDescriptor(odd, 'wishket'), (e) => e.code === 'FSW_DESCRIPTOR_INVALID' && e.path === 'fees.sellerTierBasis');
});

test('a descriptor missing a required path throws FSW_DESCRIPTOR_INVALID naming it', () => {
  const broken = structuredClone(loadDescriptor('kmong'));
  delete broken.pacing.minGapMs;
  assert.throws(() => validateDescriptor(broken, 'kmong'), (e) => e.code === 'FSW_DESCRIPTOR_INVALID' && e.path === 'pacing.minGapMs');
  assert.throws(() => loadDescriptor('nope'), (e) => e.code === 'FSW_DESCRIPTOR_INVALID');
});
