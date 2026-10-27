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

// How quote results move prices and the allocation (config.priceLearning, src/core/config.schema.json). An
// instance whose config predates the group learns nothing and expires no quote by age, the state before
// learning existed, until fsw settings reset priceLearning writes the defaults; a present group with a value
// out of range is a config error, as in pipelineSettings.
export function priceLearningSettings(config) {
  const learning = config?.priceLearning;
  if (learning == null) return { enabled: false, expireAfterDays: Infinity, reason: 'config.priceLearning is not set' };
  const need = (k, ok) => {
    if (!ok) throw Object.assign(new Error('config priceLearning.' + k + ' is out of range'), { code: 'FSW_CONFIG_MISSING' });
  };
  need('enabled', typeof learning.enabled === 'boolean');
  need('minCases', Number.isInteger(learning.minCases) && learning.minCases >= 1);
  need('step', typeof learning.step === 'number' && learning.step > 0 && learning.step <= 1);
  need('maxMove', typeof learning.maxMove === 'number' && learning.maxMove >= 0 && learning.maxMove < 1);
  need('expireAfterDays', Number.isInteger(learning.expireAfterDays) && learning.expireAfterDays >= 1);
  need('lookbackDays', Number.isInteger(learning.lookbackDays) && learning.lookbackDays >= 1);
  return { enabled: learning.enabled, minCases: learning.minCases, step: learning.step, maxMove: learning.maxMove, expireAfterDays: learning.expireAfterDays, lookbackDays: learning.lookbackDays };
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
