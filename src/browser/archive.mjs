// Archive snapshots as a market engine: the Wayback Machine's newest capture of a page, loaded raw (the
// id_ form, without the archive's toolbar or rewritten links) in the owned headless browser. Wayback
// answers a far-future timestamp with a redirect to its newest capture, so the final address names the
// capture time. A capture older than maxAgeDays fails like a missing one: the market keeps samples for
// CARRY_DAYS (src/cli/market.mjs), and an older copy would price today from a stale market.
// https://archive.org/help/wayback_api.php
const NEWEST = '29991231';

export const archiveUrl = (url, timestamp = NEWEST) => 'https://web.archive.org/web/' + timestamp + 'id_/' + url;

// The capture time an archive address names, as an ISO string, or null.
export function captureOf(href) {
  const m = /^https?:\/\/web\.archive\.org\/web\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(href ?? ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null;
}

// Wraps an owned page so navigate(url) loads the newest capture of url, and capture() returns
// {capturedAt, snapshot} for the last load.
export function archiveSession(page, { now = () => new Date(), maxAgeDays }) {
  let last = null;
  return {
    async navigate(url, opts) {
      last = null;
      await page.navigate(archiveUrl(url), opts);
      const snapshot = await page.evaluate(() => location.href);
      const capturedAt = captureOf(snapshot);
      if (!capturedAt) throw new Error('no archive snapshot of ' + url);
      const ageDays = (now().getTime() - Date.parse(capturedAt)) / 86_400_000;
      if (ageDays > maxAgeDays) throw new Error(`newest archive snapshot of ${url} is from ${capturedAt}, older than ${maxAgeDays} days`);
      last = { capturedAt, snapshot };
    },
    evaluate: page.evaluate,
    capture: () => last,
  };
}
