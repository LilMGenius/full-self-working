// The design tokens are one source: tokensCss emits one custom property per token, and the values are
// the ones site/DESIGN.md records, so the decision record and the code cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../src/core/instance.mjs';
import { TOKENS, tokensCss } from '../src/render/tokens.mjs';

const design = readFileSync(join(repoRoot, 'site', 'DESIGN.md'), 'utf8');
const props = (css) => css.replace(/^:root\{|\}$/g, '').split(';').map((d) => d.split(':')[0]);

test('tokensCss emits one :root custom property per token, named by group and kebab-case key', () => {
  const css = tokensCss();
  assert.match(css, /^:root\{[^{}]+\}$/);
  const names = props(css);
  const count = Object.keys(TOKENS.color).length + 1 + Object.keys(TOKENS.font.weights).length + Object.keys(TOKENS.type).length + Object.keys(TOKENS.space).length + Object.keys(TOKENS.radius).length;
  assert.equal(names.length, count);
  assert.equal(new Set(names).size, count, 'no property is emitted twice');
  for (const n of ['--color-ink-raised', '--color-on-ink-muted', '--font-family', '--font-display', '--type-10', '--space-4', '--radius-pill']) assert.ok(names.includes(n), n);
  assert.ok(css.includes('--color-accent:' + TOKENS.color.accent));
  assert.equal(tokensCss({ color: { a: '#000' }, font: { family: 'X', weights: { body: 400 } } }), ':root{--color-a:#000;--font-family:X;--font-body:400}');
});

test('the colour table, type steps, spacing steps and weights of site/DESIGN.md are the token values', () => {
  const table = Object.fromEntries([...design.matchAll(/^\| (\w+) \| (#[0-9A-F]{6}) \|/gm)].map((m) => [m[1], m[2]]));
  assert.deepEqual(table, TOKENS.color);
  const steps = (label) => design.match(new RegExp(label + '[^:]*: ([\\d, ]+)'))[1].split(',').map((s) => s.trim() + 'px');
  assert.deepEqual(steps('Scale in px'), Object.values(TOKENS.type));
  assert.deepEqual(steps('Spacing steps in px'), Object.values(TOKENS.space));
  const weights = design.match(/Weights: body (\d+), strong (\d+), display (\d+)/).slice(1).map(Number);
  assert.deepEqual(weights, Object.values(TOKENS.font.weights));
});

test('every colour pair the design record uses for text meets WCAG AA', () => {
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const c = TOKENS.color;
  const pairs = [['text', 'paper'], ['text', 'sheet'], ['muted', 'paper'], ['muted', 'sheet'], ['accent', 'paper'], ['accent', 'sheet'], ['onInk', 'ink'], ['onInk', 'inkRaised'], ['onInkMuted', 'ink'], ['onInkMuted', 'inkRaised'], ['accentOnInk', 'ink'], ['accentOnInk', 'inkRaised'], ['onAccent', 'accent']];
  const low = pairs.map(([f, b]) => [f + ' on ' + b, ratio(c[f], c[b])]).filter(([, r]) => r < 4.5);
  assert.deepEqual(low, []);
});

