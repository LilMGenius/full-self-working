// fsw services soomgo [--apply] [--only <service>]: sets the items each offered soomgo service matches
// customer requests on, from the decision file platforms/soomgo-service-items.json in the instance
// ({service: {heading: [label]}}, keys starting with _ are notes; examples/soomgo-service-items.json is
// a starting point). Without --apply it ticks the boxes, reads them back and discards them. Only soomgo
// matches requests through service items, so it is the only platform this verb takes.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSession } from '../browser/driver.mjs';
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { setServiceItems } from '../platforms/soomgo/services.mjs';

const USAGE = 'usage: fsw services soomgo [--apply] [--only <service>]';

export function itemDecisions(instance) {
  const file = join(instance.paths.platforms, 'soomgo-service-items.json');
  if (!existsSync(file)) throw new Error(`no ${file}; copy examples/soomgo-service-items.json there and keep only the items you can serve`);
  return Object.fromEntries(Object.entries(JSON.parse(readFileSync(file, 'utf8'))).filter(([k]) => !k.startsWith('_')));
}

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const [platform, ...rest] = argv;
  const onlyAt = rest.indexOf('--only');
  const only = onlyAt >= 0 ? rest[onlyAt + 1] : null;
  if (platform !== 'soomgo' || (onlyAt >= 0 && !only)) throw new Error(USAGE);
  const apply = rest.includes('--apply');
  const instance = ctx.instance ?? loadInstance();
  const decisions = itemDecisions(instance);
  const names = Object.keys(decisions).filter((n) => !only || n === only);
  if (!names.length) throw new Error(only ? `the decision file has no entry for ${only}` : 'the decision file names no service');
  const set = ctx.setServiceItems ?? setServiceItems;
  const session = ctx.session ?? (await openSession('soomgo-services', { platform: 'soomgo', pacing: loadDescriptor('soomgo').pacing }));
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  let failed = 0;
  try {
    for (const name of names) {
      try {
        const r = await set(session, name, decisions[name], { dryRun: !apply });
        if (!r.ticked) log(`${name}: every wanted item is already set`);
        else if (!apply) log(`${name}: ${r.ticked} items ticked and read back, then discarded (dry run)`);
        else if (r.saved) {
          log(`${name}: ${r.ticked} items saved and read back`);
          ledger.addEvent({ kind: 'platform.service_items', platform: 'soomgo', ref: name, payload: { ticked: r.ticked } });
        } else {
          failed += 1;
          log(`${name}: saved, but soomgo did not keep ${r.notKept ?? 'the items'}`);
        }
      } catch (err) {
        failed += 1;
        log(`${name}: ${err.code ? err.code + ' ' : ''}${err.message}`);
      }
    }
  } finally {
    if (!ctx.session) await session.stop();
    if (!ctx.ledger) ledger.close();
  }
  return failed ? 1 : 0;
}

