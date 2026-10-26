// Deterministic copy lint. Floor findings block an outbound item; reflex findings warn.
// Rules come from the repository slop gate (AGENTS.md): no em dashes, no middle-dot enumerations,
// no placeholders, no AI self-reference, and a reflex list of hype and vanity phrasing.

const FLOOR = [
  { rule: 'em_dash', re: /[\u2014\u2015]/g },
  // A middle dot between letters is an enumeration (개발·디자인); between digits it is a name (3·1운동).
  { rule: 'middle_dot', re: /(?<=\p{L}[ ]?)\u00B7(?=[ ]?\p{L})/gu },
  { rule: 'placeholder', re: /lorem ipsum|\bTODO\b|\bTBD\b|\bXXX\b|\{\{[^}]*\}\}|\[(?:이름|성함|회사명|고객명|날짜|금액|연락처|name|company|client)\]/giu },
  { rule: 'ai_self_reference', re: /\bas an AI\b|\bI(?: am|'m) an AI\b|AI 언어 ?모델|인공지능으로서|AI로서|언어 모델로서/giu },
];

const HYPE_KO = ['혁신적인', '최고의', '압도적인', '완벽한', '획기적인', '차별화된', '원스톱'];
const HYPE_EN = ['revolutionary', 'cutting-edge', 'seamless', 'world-class', 'game-changer', 'unleash', 'elevate', 'delve', 'leverage'];
const words = (list) => list.map((w) => w.replace(/[-]/g, '\\-')).join('|');

function reflexRules(lang) {
  const rules = [
    { rule: 'stacked_exclamation', re: /!{2,}/g },
    { rule: 'emoji_bullet', re: /^[ \t]*\p{Extended_Pictographic}/gmu },
    { rule: 'welcome_phrase', re: /에 오신 것을 환영합니다/g },
    { rule: 'vanity_metric', re: /만족도\s*100\s*%|\d[\d,]{2,}\s*\+/g },
  ];
  if (lang !== 'en') rules.push({ rule: 'hype_ko', re: new RegExp(words(HYPE_KO), 'g') });
  if (lang !== 'ko') rules.push({ rule: 'hype_en', re: new RegExp(`\\b(?:${words(HYPE_EN)})\\w*`, 'gi') });
  return rules;
}

function excerpt(text, index, length) {
  const start = Math.max(0, index - 12);
  return text.slice(start, Math.min(text.length, index + length + 12)).replace(/\s+/g, ' ');
}

export function lintText(text, { lang } = {}) {
  const findings = [];
  const src = String(text ?? '');
  const run = (rules, tier) => {
    for (const { rule, re } of rules) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) findings.push({ rule, tier, index: m.index, excerpt: excerpt(src, m.index, m[0].length) });
    }
  };
  run(FLOOR, 'floor');
  run(reflexRules(lang), 'reflex');
  return findings.sort((a, b) => a.index - b.index);
}

export const floorFindings = (text, opts) => lintText(text, opts).filter((f) => f.tier === 'floor');
