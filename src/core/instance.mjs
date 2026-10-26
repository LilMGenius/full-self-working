// Loads the operator instance (FSW_INSTANCE, default <repo>/instance.local).
// The instance is the only place personal data lives; examples/instance holds the same shapes.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const exampleDir = join(repoRoot, 'examples', 'instance');

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function missing(file, dir) {
  const err = new Error(`instance file missing: ${file} (in ${dir})`);
  err.code = 'FSW_INSTANCE_MISSING';
  err.file = file;
  return err;
}

export function instanceDir(dir) {
  return resolve(dir ?? process.env.FSW_INSTANCE ?? join(repoRoot, 'instance.local'));
}

export function loadInstance({ dir, allowExampleConfig = false } = {}) {
  const root = instanceDir(dir);
  const required = (file) => {
    const path = join(root, file);
    if (!existsSync(path)) throw missing(file, root);
    return readJson(path);
  };
  const profile = required('profile.json');
  const business = required('business.json');
  let config;
  if (existsSync(join(root, 'config.json'))) config = readJson(join(root, 'config.json'));
  else if (allowExampleConfig) config = readJson(join(exampleDir, 'config.json'));
  else throw missing('config.json', root);
  const operator = join(root, 'operator');
  return {
    dir: root,
    profile,
    business,
    config,
    paths: {
      ledger: join(root, 'ledger.sqlite'),
      market: join(root, 'market'),
      platforms: join(root, 'platforms'),
      jobs: join(root, 'jobs'),
      portfolio: join(root, 'portfolio'),
      pricing: join(root, 'pricing'),
      lessons: join(root, 'lessons'),
      operator,
      approvals: join(operator, 'approvals'),
      logs: join(root, 'logs'),
      background: join(root, 'background.md'),
    },
  };
}
