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

test('wishket forbids identifying details, and an identity rule other than allowed or forbidden is refused', () => {
  assert.equal(loadDescriptor('wishket').contactPolicy.identity, 'forbidden');
  const odd = structuredClone(loadDescriptor('wishket'));
  odd.contactPolicy.identity = 'sometimes';
  assert.throws(() => validateDescriptor(odd, 'wishket'), (e) => e.code === 'FSW_DESCRIPTOR_INVALID' && e.path === 'contactPolicy.identity');
});

test('soomgo refunds a quote unread after 48 hours, and a refund window that is not a positive whole hour is refused', () => {
  assert.equal(loadDescriptor('soomgo').bidCost.unreadRefundHours, 48);
  for (const v of [0, -1, 1.5, '48']) {
    const odd = structuredClone(loadDescriptor('soomgo'));
    odd.bidCost.unreadRefundHours = v;
    assert.throws(() => validateDescriptor(odd, 'soomgo'), (e) => e.code === 'FSW_DESCRIPTOR_INVALID' && e.path === 'bidCost.unreadRefundHours', JSON.stringify(v));
  }
});

test('a descriptor missing a required path throws FSW_DESCRIPTOR_INVALID naming it', () => {
  const broken = structuredClone(loadDescriptor('kmong'));
  delete broken.pacing.minGapMs;
  assert.throws(() => validateDescriptor(broken, 'kmong'), (e) => e.code === 'FSW_DESCRIPTOR_INVALID' && e.path === 'pacing.minGapMs');
  assert.throws(() => loadDescriptor('nope'), (e) => e.code === 'FSW_DESCRIPTOR_INVALID');
});

test('every descriptor lists its outbound forms, the kinds a person confirms and a proposal limit', () => {
  for (const id of listDescriptors()) {
    const d = loadDescriptor(id);
    assert.equal(typeof d.forms, 'object', id);
    assert.ok(Array.isArray(d.automation.sendRequiresOperator), id);
    assert.ok('proposal' in d.limits, id);
  }
  assert.equal(loadDescriptor('kmong').limits.proposal.maxChars, 3000);
  assert.deepEqual(loadDescriptor('upwork').automation.sendRequiresOperator, ['proposal', 'message']);
  const broken = structuredClone(loadDescriptor('freelancer'));
  delete broken.limits.proposal;
  assert.throws(() => validateDescriptor(broken, 'freelancer'), (e) => e.code === 'FSW_DESCRIPTOR_INVALID' && e.path === 'limits.proposal.maxChars');
});

test('a mapped form names when it was mapped and its recording, and forms take only outbound kinds', () => {
  const base = loadDescriptor('freelancer');
  const withForm = (form, kind = 'proposal') => {
    const d = structuredClone(base);
    d.forms[kind] = form;
    return d;
  };
  const mapped = { mapped: true, mappedAt: '2026-10-28T00:00:00Z', recording: 'instance.local/qa/surfaces/freelancer/x.jsonl', readBack: true };
  assert.equal(validateDescriptor(withForm(mapped), 'freelancer').forms.proposal.mapped, true);
  const bad = (d, path) => assert.throws(() => validateDescriptor(d, 'freelancer'), (e) => e.code === 'FSW_DESCRIPTOR_INVALID' && e.path === path);
  bad(withForm({ ...mapped, mappedAt: null }), 'forms.proposal');
  bad(withForm({ ...mapped, recording: null }), 'forms.proposal');
  bad(withForm({ ...mapped, readBack: false }), 'forms.proposal');
  bad(withForm({ ...mapped, mapped: 'yes' }), 'forms.proposal');
  bad(withForm(mapped, 'delivery'), 'forms.delivery');
  const sro = structuredClone(base);
  sro.automation.sendRequiresOperator = ['delivery'];
  bad(sro, 'automation.sendRequiresOperator');
});
