// Generates media/vendors/<vendor>.svg: the same simple marks the webview uses (not company logos).
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'media', 'vendors');
fs.mkdirSync(dir, { recursive: true });
const spark = '<path fill="#fff" d="M8 2.2 8.9 6.5l3.2-3-1.9 3.9 4.3.8-4.3.9 1.9 3.8-3.2-2.9L8 14.3l-.9-4.3-3.2 2.9 1.9-3.8-4.3-.9 4.3-.8-1.9-3.9 3.2 3z"/>';
const star = '<path fill="#fff" d="M8 2.2c.5 3.1 2.7 5.3 5.8 5.8-3.1.5-5.3 2.7-5.8 5.8-.5-3.1-2.7-5.3-5.8-5.8 3.1-.5 5.3-2.7 5.8-5.8z"/>';
const text = (t, size = 7) => `<text x="8" y="8.4" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="${size}" fill="#fff">${t}</text>`;
const V = {
  anthropic: ['#D97757', spark],
  openai: ['#10A37F', text('GPT', 5.2)],
  google: ['#4285F4', star],
  meta: ['#0866FF', text('L')],
  qwen: ['#615CED', text('Q')],
  deepseek: ['#4D6BFE', text('DS', 6)],
  mistral: ['#FA520F', text('M')],
  xai: ['#111111', text('X')],
  other: ['#71717A', text('?')],
};
for (const [name, [bg, inner]] of Object.entries(V)) {
  fs.writeFileSync(path.join(dir, `${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3.5" fill="${bg}"/>${inner}</svg>\n`);
}
console.log('wrote', Object.keys(V).length, 'icons to', dir);
