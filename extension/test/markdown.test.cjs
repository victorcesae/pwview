// Renders the chat's Markdown component to HTML and checks the formatting.
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'agentlens-md-build', 'md.cjs');
const entry = path.join(__dirname, '.md-entry.tsx');
require('fs').writeFileSync(
  entry,
  `import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Markdown } from ${JSON.stringify(path.join(root, 'webview/src/components/Markdown.tsx').replace(/\\/g, '/'))};
export const render = (text) => renderToStaticMarkup(createElement(Markdown, { text }));`,
);
execSync(`npx esbuild "${entry}" --bundle --platform=node --format=cjs --jsx=automatic --outfile="${out}" --alias:@=./webview/src --log-level=error`, { cwd: root });
const { render } = require(out);

test('markdown: tables render as tables with alignment', () => {
  const html = render('| Mode | When |\n|---|:--:|\n| **Queue** | turn end |\n| Steer | next step |');
  assert.match(html, /<table/);
  assert.match(html, /<th[^>]*>Mode<\/th>/);
  assert.match(html, /<td[^>]*text-align:center[^>]*>turn end<\/td>/);
  assert.match(html, /<strong>Queue<\/strong>/);
  assert.doesNotMatch(html, /\|/, 'no raw pipes left');
});

test('markdown: rules, headings, lists, code', () => {
  const html = render('## Title\n\nText with `code` and **bold**.\n\n---\n\n- one\n- two\n\n1. a\n2. b\n\n```ts\nconst x = 1;\n```');
  assert.match(html, /<hr/);
  assert.match(html, /font-semibold[^>]*>Title</);
  assert.match(html, /<ul[^>]*><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol/);
  assert.match(html, /<pre[^>]*><code>const x = 1;<\/code><\/pre>/);
  assert.doesNotMatch(html, /---/);
});

test('markdown: no HTML injection', () => {
  const html = render('<img src=x onerror=alert(1)> **ok**');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
