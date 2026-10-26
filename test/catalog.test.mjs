import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { answeredCatalog, answeredServices, catalog, catalogServicesFor, deliveryOf, operatorDelivered, targetsFor } from '../src/economics/catalog.mjs';

test('a platform label maps to the catalog services whose market category it is, plus the descriptor additions', () => {
  const soomgo = loadDescriptor('soomgo');
  assert.deepEqual(catalogServicesFor(soomgo, '웹 개발').sort(), ['landing_page_web', 'web_app_dev']);
  assert.deepEqual(catalogServicesFor(soomgo, '로고 디자인'), ['logo_brand']);
  assert.deepEqual(catalogServicesFor(loadDescriptor('kmong'), '로고 디자인'), ['logo_brand']);
});

test('a label outside the catalog is an empty list and a missing label is undefined', () => {
  const soomgo = loadDescriptor('soomgo');
  assert.deepEqual(catalogServicesFor(soomgo, '피아노 레슨'), []);
  assert.equal(catalogServicesFor(soomgo, null), undefined);
  assert.equal(catalogServicesFor(loadDescriptor('upwork'), '로고 디자인'), undefined);
});

test('market targets are one per distinct category and skip services without one', () => {
  const kmong = targetsFor('kmong');
  assert.equal(new Set(kmong.map((t) => t.category)).size, kmong.length);
  assert.ok(!kmong.some((t) => t.def === catalog.copywriting));
  assert.deepEqual(targetsFor('upwork'), []);
});

test('soomgo files lessons under 프로그래밍/코딩 레슨, which maps to the lesson service and is sampled with the other guides', () => {
  assert.deepEqual(catalogServicesFor(loadDescriptor('soomgo'), '프로그래밍/코딩 레슨'), ['lesson_tutoring']);
  assert.ok(targetsFor('soomgo').some((t) => t.category === '프로그래밍/코딩 레슨'));
});

test('soomgo game, Android, iOS and ERP requests map to catalog services', () => {
  const soomgo = loadDescriptor('soomgo');
  assert.deepEqual(catalogServicesFor(soomgo, '게임 개발'), ['game_dev']);
  assert.deepEqual(catalogServicesFor(soomgo, '안드로이드 개발'), ['mobile_app_dev']);
  assert.deepEqual(catalogServicesFor(soomgo, 'iOS 개발'), ['mobile_app_dev']);
  assert.deepEqual(catalogServicesFor(soomgo, 'ERP 개발'), ['erp_dev']);
});

test('a setting naming a service the catalog does not hold is a config error', () => {
  assert.throws(() => answeredServices({ platforms: { soomgo: { services: ['lessons'] } } }, 'soomgo'), { code: 'FSW_CONFIG_INVALID', message: /lessons, which the catalog does not hold/ });
  assert.throws(() => answeredServices({ platforms: { soomgo: { services: 'lesson_tutoring' } } }, 'soomgo'), { code: 'FSW_CONFIG_INVALID' });
  assert.deepEqual(answeredServices({ platforms: { soomgo: { services: ['lesson_tutoring', 'logo_brand'] } } }, 'soomgo'), ['logo_brand', 'lesson_tutoring']);
});

test('an unset platform answers every agent-delivered service, and an operator service only once the config lists it', () => {
  assert.equal(deliveryOf(catalog.logo_brand), 'agent');
  assert.ok(operatorDelivered('lesson_tutoring'));
  assert.throws(() => deliveryOf({ delivery: 'robot' }), { code: 'FSW_SERVICE_INVALID' });
  const unset = answeredServices({ platforms: { soomgo: { services: null } } }, 'soomgo');
  assert.ok(unset.includes('logo_brand') && !unset.includes('lesson_tutoring'));
  const cut = answeredCatalog({ platforms: { soomgo: { services: ['lesson_tutoring'] } } }, 'soomgo');
  assert.deepEqual(Object.keys(cut), ['_notes', 'lesson_tutoring']);
});
