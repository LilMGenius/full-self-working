import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../src/core/instance.mjs';
import * as publish from '../scripts/publish.mjs';

const readDeployReport = (text) => publish.readDeployReport(text);

// The supervisor's publish job keeps the last five output lines (src/supervisor/run.mjs), so they must
// carry the failure's code and cause.
test('a failed publish ends its output on the failure code and cause', () => {
  const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'publish.mjs'), '--bogus'], { cwd: repoRoot, encoding: 'utf8' });
  const tail = (r.stdout + r.stderr).trim().split('\n').slice(-5).join('\n');
  assert.equal(r.status, 1);
  assert.match(tail, /FSW_PUBLISH_ARGS unknown argument --bogus/);
});



// The stdout of vercel 65.2.0 deploy --json under the scheduled supervisor, recorded 2026-10-27 from a preview
// deploy with every agent variable unset (identifiers replaced): the bare deployment, no status, no envelope.
const BARE = readFileSync(join(repoRoot, 'test', 'fixtures', 'vercel', 'deploy-json-65.2.0.json'), 'utf8');
const asProduction = (text) => text.replace('"productionUrl": null', '"productionUrl": "https://example.invalid"').replace('"target": null', '"target": "production"');

test('a deploy report is read in the shape vercel 65.2.0 prints without an agent and in its agent envelope, and only a ready production one passes', () => {
  assert.deepEqual(readDeployReport(asProduction(BARE)), { url: 'https://site-abc123xyz-example-team.vercel.app', id: 'dpl_EXAMPLE0000000000000000000', productionUrl: 'https://example.invalid' });
  const deployment = JSON.parse(asProduction(BARE));
  assert.deepEqual(readDeployReport(JSON.stringify({ status: 'ok', deployment, message: 'ready', next: [] })).url, deployment.url);
  const refused = (text) => assert.throws(() => readDeployReport(text), (err) => err.code === 'FSW_PUBLISH_DEPLOY');
  refused(BARE);
  refused(JSON.stringify({ ...deployment, readyState: 'ERROR' }));
  refused(JSON.stringify({ ...deployment, url: 'http://insecure' }));
  refused(JSON.stringify({ ...deployment, error: { name: 'VERIFICATION_FAILED', message: 'no 200' } }));
  refused(JSON.stringify({ status: 'error', deployment }));
  refused('Error: no JSON here');
});
