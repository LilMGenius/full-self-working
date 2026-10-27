// Media for a repository item the operator authored that has none: its README as GitHub renders it, captured from
// the public page, with kind 'readme' and its own caption, never presented as a running screen. An item with neither
// media nor a repository is returned in missing, for the operator, and so is a repository GitHub would not show
// (404, private, a dropped network), with what GitHub answered in reasons, since it may be the operator's own; another
// maintainer's repository gets nothing.
import { join } from 'node:path';
import { repoOf } from './signals.mjs';

const README_RECT = '(() => { const e = document.querySelector("article.markdown-body"); if (!e) return null; const r = e.getBoundingClientRect();' +
  ' return { x: Math.round(r.left), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(Math.min(r.height, 1600)) }; })()';

export async function captureRepoMedia(items, { renderer, dir, reach = {} }) {
  const media = {};
  const missing = [];
  const reasons = {};
  for (const i of items) {
    if ((i.media ?? []).length) continue;
    const repo = repoOf(i.url);
    if (!repo) {
      missing.push(i.id);
      continue;
    }
    if (!reach[i.id]?.authored) {
      if (reach[i.id]?.why === 'repository unread') {
        missing.push(i.id);
        reasons[i.id] = reach[i.id].errors?.[0] ?? 'repository unread';
      }
      continue;
    }
    const url = 'https://github.com/' + repo;
    const out = join(dir, i.id + '-readme.png');
    const located = await renderer.render({ url, width: 1440, height: 900, out, format: 'png', probe: README_RECT });
    if (!located.probe) {
      missing.push(i.id);
      continue;
    }
    const shot = await renderer.render({ url, width: 1440, height: 900, clip: located.probe, out, format: 'png', scale: 2 });
    media[i.id] = [{ kind: 'readme', src: 'media/' + i.id + '-readme.png', width: shot.width, height: shot.height, alt: 'README of ' + repo + ' on GitHub' }];
  }
  return { media, missing, reasons };
}
