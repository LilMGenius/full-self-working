#!/usr/bin/env node
// Loads every platform descriptor through the registry so a malformed one fails the check.
import { listDescriptors, loadDescriptor } from '../src/platforms/registry.mjs';

let failed = 0;
for (const id of listDescriptors()) {
  try {
    const d = loadDescriptor(id);
    const unknown = JSON.stringify(d).match(/"unknown"/g)?.length ?? 0;
    console.log(`check-descriptors: ${id} ok (${d.sources.length} sources, ${unknown} unknown fields)`);
  } catch (err) {
    failed++;
    console.error(`check-descriptors: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
