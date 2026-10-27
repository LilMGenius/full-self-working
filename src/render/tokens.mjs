// Design tokens of the public surfaces (site/DESIGN.md is the decision record). Data first: the site CSS
// and the listing images read these values through tokensCss(), so a colour or a type step changes once.
export const TOKENS = Object.freeze({
  color: {
    ink: '#121418',
    inkRaised: '#1D2026',
    paper: '#F3F4F6',
    sheet: '#FFFFFF',
    text: '#121418',
    muted: '#596069',
    line: '#D8DBE0',
    lineOnInk: '#33373D',
    accent: '#CF3315',
    accentOnInk: '#F26A48',
    onInk: '#F3F4F6',
    onInkMuted: '#A2A8B1',
    onAccent: '#FFFFFF',
  },
  font: { family: '"Pretendard", sans-serif', weights: { body: 450, strong: 650, display: 800 } },
  type: { 1: '13px', 2: '15px', 3: '17px', 4: '20px', 5: '24px', 6: '32px', 7: '44px', 8: '60px', 9: '88px', 10: '112px' },
  space: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '24px', 6: '32px', 7: '48px', 8: '64px', 9: '96px', 10: '128px' },
  radius: { sm: '4px', md: '8px', lg: '14px', pill: '999px' },
});

const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

// :root custom properties, one per token: --color-paper, --type-3, --space-4 ...
export function tokensCss(tokens = TOKENS) {
  const vars = [];
  for (const [group, values] of Object.entries(tokens)) {
    if (group === 'font') {
      vars.push('--font-family:' + values.family);
      for (const [k, v] of Object.entries(values.weights)) vars.push('--font-' + kebab(k) + ':' + v);
      continue;
    }
    for (const [k, v] of Object.entries(values)) vars.push('--' + group + '-' + kebab(k) + ':' + v);
  }
  return ':root{' + vars.join(';') + '}';
}
