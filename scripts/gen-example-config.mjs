#!/usr/bin/env node
// Writes examples/instance/config.json from the defaults of src/core/config.schema.json, so the example a
// new operator copies never drifts from the schema; --check exits 1 when the committed file differs.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultsOf, loadSchema } from '../src/core/config.mjs';
import { exampleDir } from '../src/core/instance.mjs';

export const exampleConfigFile = join(exampleDir, 'config.json');
export const generated = () => JSON.stringify(defaultsOf(loadSchema()), null, 2) + '\n';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--check')) {
    if (readFileSync(exampleConfigFile, 'utf8').replace(/\r\n/g, '\n') !== generated()) {
      console.error('gen-example-config: examples/instance/config.json differs from the schema defaults; run node scripts/gen-example-config.mjs');
      process.exit(1);
    }
    console.log('gen-example-config: examples/instance/config.json matches the schema defaults');
  } else {
    writeFileSync(exampleConfigFile, generated());
    console.log('gen-example-config: wrote ' + exampleConfigFile);
  }
}
