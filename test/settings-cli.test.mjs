// fsw settings and the schema behind it (003 Settings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exampleDir, repoRoot } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { defaultsOf, keyInfo, loadSchema, undocumentedKeys, unmadeChoices, validateConfig } from '../src/core/config.mjs';
import { generated } from '../scripts/gen-example-config.mjs';
import { run } from '../src/cli/settings.mjs';
import { listDescriptors } from '../src/platforms/registry.mjs';
import { tempDir } from './tmp.mjs';

function instanceDir() {
  const dir = tempDir('fsw-settings-');
  for (const f of ['profile.json', 'business.json', 'config.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  return dir;
}
const call = async (dir, argv) => {
  const out = [];
  const err = [];
  const ledger = openLedger(join(dir, 'ledger.sqlite'));
  try {
    const code = await run(argv, { dir, ledger, log: (l) => out.push(l), error: (l) => err.push(l) });
    return { code, out, err, events: ledger.db.prepare("SELECT ref, payload FROM events WHERE kind = 'settings.changed'").all().map((e) => JSON.parse(e.payload)) };
  } finally {
    ledger.close();
  }
};

test('the committed example config is the schema defaults, and every schema key has a meaning and a default', () => {
  assert.equal(readFileSync(join(exampleDir, 'config.json'), 'utf8').replace(/\r\n/g, '\n'), generated());
  assert.deepEqual(JSON.parse(generated()), defaultsOf(loadSchema()));
  assert.deepEqual(undocumentedKeys(), []);
  assert.deepEqual(undocumentedKeys({ properties: { a: { type: 'string', default: 'x' }, b: { description: 'b' } } }), ['a has no description', 'b has no default']);
});

test('set of an invalid enum exits 1 and leaves config.json byte-identical', async () => {
  const dir = instanceDir();
  const before = readFileSync(join(dir, 'config.json'));
  const r = await call(dir, ['set', 'platforms.soomgo.mode', 'loud']);
  assert.equal(r.code, 1);
  assert.match(r.err[0], /^settings: config\/platforms\/soomgo\/mode must be equal to one of the allowed values: "observe", "draft", "auto"; config.json is unchanged$/);
  assert.deepEqual(readFileSync(join(dir, 'config.json')), before);
  assert.deepEqual(r.events, []);
});

test('set under a platform id no descriptor names exits 1 and leaves config.json byte-identical', async () => {
  assert.deepEqual(loadSchema().properties.platforms.propertyNames.enum, listDescriptors());
  const dir = instanceDir();
  const before = readFileSync(join(dir, 'config.json'));
  const r = await call(dir, ['set', 'platforms.soomg.enabled', 'true']);
  assert.equal(r.code, 1);
  assert.match(r.err[0], /^settings: config\/platforms key "soomg" must be equal to one of the allowed values: "fiverr", .*"wishket"; config.json is unchanged$/);
  assert.deepEqual(readFileSync(join(dir, 'config.json')), before);
  assert.deepEqual(r.events, []);
});

test('a valid set writes the new file and one settings.changed event, and reset restores the default', async () => {
  const dir = instanceDir();
  const set = await call(dir, ['set', 'platforms.soomgo.maxCashPerDay', '5000']);
  assert.equal(set.code, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).platforms.soomgo.maxCashPerDay, 5000);
  assert.deepEqual(set.events, [{ key: 'platforms.soomgo.maxCashPerDay', old: 0, new: 5000 }]);
  const text = await call(dir, ['set', 'listings.studio', 'Test Studio']);
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).listings.studio, 'Test Studio');
  assert.equal(text.code, 0);
  const reset = await call(dir, ['reset', 'activeHours.outbound']);
  assert.equal(reset.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).activeHours.outbound, ['08:00', '23:00']);
  assert.equal((await call(dir, ['set', 'no.such.key', '1'])).code, 1);
  assert.equal((await call(dir, ['set'])).code, 2);
});

test('the list prints each key with its value, default and meaning, map keys per platform', async () => {
  const r = await call(instanceDir(), []);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('platforms.soomgo.maxCashPerDay = 0 (default null) cash in KRW quotes may spend here in one Seoul day; 0 or null refuses every cash quote'), r.out.join('\n').slice(0, 2000));
  assert.ok(r.out.some((l) => l.startsWith('market.engines.fiverr = null (default null) ')));
  assert.ok(r.out.some((l) => l.startsWith('platforms.kmong.proposals.maxPerDay = 5 (default 5) ')));
});

test('unmade choices name platforms.soomgo.bidBudget until it is set, and a config written before browser was an object still validates', async () => {
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  assert.ok(unmadeChoices(config).some((c) => c.key === 'platforms.soomgo.bidBudget'));
  config.platforms.soomgo.bidBudget = { monthlyKRW: 0, stopAfterUnanswered: 20 };
  assert.ok(!unmadeChoices(config).some((c) => c.key === 'platforms.soomgo.bidBudget'), 'a value equal to the default counts as made');
  assert.ok(!unmadeChoices(config).some((c) => c.key.startsWith('platforms.wishket')), 'a disabled platform asks nothing');
  assert.equal(await validateConfig({ ...config, browser: 'chrome-2' }), true);
  assert.deepEqual(keyInfo(loadSchema(), 'platforms.anyone.mode').enum, ['observe', 'draft', 'auto']);
});

test('src/cli/run.mjs imports without ajv, and only fsw settings set needs it', () => {
  const dir = tempDir('fsw-noajv-');
  writeFileSync(join(dir, 'hooks.mjs'), "export async function resolve(specifier, context, next) { if (specifier === 'ajv' || specifier.startsWith('ajv/')) throw new Error('ajv cannot be resolved here'); return next(specifier, context); }\n");
  writeFileSync(join(dir, 'register.mjs'), "import { register } from 'node:module';\nregister(" + JSON.stringify(pathToFileURL(join(dir, 'hooks.mjs')).href) + ');\n');
  const inst = instanceDir();
  const script = [
    "await import(" + JSON.stringify(pathToFileURL(join(repoRoot, 'src', 'cli', 'run.mjs')).href) + ");",
    "console.log('run.mjs imported');",
    "const { run } = await import(" + JSON.stringify(pathToFileURL(join(repoRoot, 'src', 'cli', 'settings.mjs')).href) + ");",
    "await run(['set', 'notify.toast', 'false'], { dir: " + JSON.stringify(inst) + " });",
  ].join('\n');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'register.mjs')).href, '--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true });
  assert.match(r.stdout, /run\.mjs imported/);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ajv cannot be resolved here/);
});
