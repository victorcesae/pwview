// Path detection for the media / file preview cards under messages (webview/src/lib/mediaPaths.ts).
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-media-build', 'media.cjs');
execSync(`npx esbuild webview/src/lib/mediaPaths.ts --bundle --platform=node --format=cjs --outfile="${out}" --log-level=error`, { cwd: root });
const { detectMediaPaths, mediaKind, toolText } = require(out);

test('media: kinds by extension', () => {
  assert.equal(mediaKind('a/b.PNG'), 'image');
  assert.equal(mediaKind('x.webm'), 'video');
  assert.equal(mediaKind('x.flac'), 'audio');
  assert.equal(mediaKind('r.pdf'), 'pdf');
  assert.equal(mediaKind('d.xlsx'), 'doc');
  assert.equal(mediaKind('s.ts'), undefined);
});

test('media: absolute, relative, home and Windows paths', () => {
  assert.deepEqual(detectMediaPaths('Saved the chart to /tmp/out/chart.png and the clip to ./media/demo.mp4.'), ['/tmp/out/chart.png', './media/demo.mp4']);
  assert.deepEqual(detectMediaPaths('see `docs/report.pdf`, ~/Music/a.mp3 and C:\\Users\\me\\b.docx'), ['docs/report.pdf', '~/Music/a.mp3', 'C:\\Users\\me\\b.docx']);
  assert.deepEqual(detectMediaPaths('wrote screenshot.png'), ['screenshot.png']);
});

test('media: skips URLs, code files, bare extensions and globs', () => {
  assert.deepEqual(detectMediaPaths('https://example.com/a.png and http://x.io/v.mp4'), []);
  assert.deepEqual(detectMediaPaths('edited src/app.ts and README.md'), []);
  assert.deepEqual(detectMediaPaths('convert .png files with *.jpg'), []);
});

test('media: markdown links, file:// and quoted names with spaces', () => {
  assert.deepEqual(detectMediaPaths('![chart](out/chart.svg) [deck](slides.pptx)'), ['out/chart.svg', 'slides.pptx']);
  assert.deepEqual(detectMediaPaths('open file:///home/me/x.pdf'), ['/home/me/x.pdf']);
  assert.ok(detectMediaPaths('saved "My Report.pdf"').includes('My Report.pdf'));
});

test('media: dedupes and caps', () => {
  assert.deepEqual(detectMediaPaths('a.png a.png b.png'), ['a.png', 'b.png']);
  const many = Array.from({ length: 30 }, (_, i) => `f${i}.png`).join(' ');
  assert.equal(detectMediaPaths(many, 8).length, 8);
});

test('media: tool text takes paths from inputs and output', () => {
  const s = toolText({ file_path: '/w/a.png', content: 'ignored b.png' }, 'ok c.mp4');
  assert.deepEqual(detectMediaPaths(s), ['/w/a.png', 'c.mp4']);
});
