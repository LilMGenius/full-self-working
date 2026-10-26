// Config readers that triage, policy, the loop and the supervisor share. Moved unchanged from
// src/pipeline/thread.mjs:18,33-43, src/orders/money.mjs:49-52 and src/supervisor/run.mjs:147-157 at
// 2c77326, so none of those modules imports another to read one setting.
export const MODES = ['observe', 'draft', 'auto'];
const RANK = Object.fromEntries(MODES.map((m, i) => [m, i]));

// Hours after which an item is too old to answer, per kind, and the confidence below which auto mode
// asks the operator. A missing value is a config error raised before anything is opened, never a
// default that answers any age.
export function pipelineSettings(config) {
  const p = config?.pipeline ?? {};
  const windows = p.replyWindowHours ?? {};
  for (const [path, v] of [['replyWindowHours.message', windows.message], ['replyWindowHours.request', windows.request], ['minAutoConfidence', p.minAutoConfidence]]) {
    if (typeof v !== 'number' || !(v >= 0)) throw Object.assign(new Error('config pipeline.' + path + ' must be a number'), { code: 'FSW_CONFIG_MISSING' });
  }
  return { replyWindowHours: windows, minAutoConfidence: p.minAutoConfidence };
}

// Until the operator records a watched first order, every reply in an accepted or paid thread goes to
// the operator.
export const ordersWatched = (config) => config?.orders?.watched === true;

// The browser a notice names: the operator's Chrome profile is a setting (browser.chromeProfile), so no
// profile name sits in tracked code; null names plain Chrome.
export const chromeName = (config) => (config?.browser?.chromeProfile ? 'Chrome (profile ' + config.browser.chromeProfile + ')' : 'Chrome');

// FSW_FORCE_MODE can only lower a platform's mode (auto > draft > observe).
export function effectiveMode(configMode, forceMode) {
  if (forceMode == null || forceMode === '') return configMode;
  if (!MODES.includes(forceMode)) throw new RangeError('FSW_FORCE_MODE must be one of ' + MODES.join(', ') + ', got ' + forceMode);
  return RANK[forceMode] < RANK[configMode] ? forceMode : configMode;
}
