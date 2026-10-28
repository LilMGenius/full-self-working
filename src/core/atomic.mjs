// Writes a file whole or not at all: the text goes to a temporary file beside it, named for this process so two
// processes never share one, and is renamed over the target, so a reader sees the old file or the new one.
import { renameSync, writeFileSync } from 'node:fs';

export function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
