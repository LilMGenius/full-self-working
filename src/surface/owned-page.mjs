// The pages a market sampler reads through, by the platform's market engine (moved from
// src/cli/market.mjs at main, where withOwnedPage sat at :58-73 at 2c77326 and the engine openers came in
// 9101c1c). Every page a market read opens is a surface session: owned is a headless browser with a fresh
// profile, one renderer per platform run and the descriptor's page gap before every load, with no part of
// the operator's signed-in Chrome; attached is a BrowserSkill session of the operator's Chrome, which reads
// only public pages; archive is the newest Wayback capture loaded in the owned page and dated by its
// capture (src/browser/archive.mjs). sampleMarket (src/economics/sampling.mjs) takes withMarketPage as
// withPage and passes the engine config.market.engines.<platform> names.
import { archiveSession } from '../browser/archive.mjs';
import { createPacingGuard, withSession } from '../browser/driver.mjs';
import { CARRY_DAYS } from '../economics/sampling.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { openRenderer } from '../render/html2png.mjs';

export async function withOwnedPage(platform, fn) {
  const renderer = await openRenderer();
  try {
    const page = await renderer.page();
    const guard = createPacingGuard(platform, loadDescriptor(platform).pacing);
    return await fn({
      async navigate(url, opts) {
        await guard.beforeLoad();
        return page.navigate(url, opts);
      },
      evaluate: page.evaluate,
    });
  } finally {
    await renderer.close();
  }
}

const withAttachedPage = (platform, fn) => withSession('market-' + platform, (s) => fn({ navigate: s.navigate, evaluate: s.evaluate }), { platform, pacing: loadDescriptor(platform).pacing });
const withArchivePage = (platform, fn, { now }) => withOwnedPage(platform, (page) => fn(archiveSession(page, { now, maxAgeDays: CARRY_DAYS })));
const ENGINES = { owned: withOwnedPage, attached: withAttachedPage, archive: withArchivePage };

export const withMarketPage = (platform, fn, { engine = 'owned', now = () => new Date() } = {}) => {
  if (!ENGINES[engine]) throw Object.assign(new Error('no page opener for the market engine ' + engine), { code: 'FSW_MARKET_ENGINE_UNKNOWN' });
  return ENGINES[engine](platform, fn, { now });
};
