// In the pwview browser: Ctrl+F on the 2,000-message chat, find a far-away message, step through
// matches, check "Load earlier", agent avatar and the idle ring. Usage: node build/demo-search.cjs <port> <baseUrl> <outDir>
const fs = require('fs');
const path = require('path');
const [port, baseUrl, outDir] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) pending.get(m.id)(m.result ?? m.error), pending.delete(m.id);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0]);
  };
  const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
  const results = [];
  const check = (name, ok, detail = '') => results.push(`${ok ? '✔' : '✖'} ${name}${detail ? '  (' + detail + ')' : ''}`);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await send('Page.navigate', { url: baseUrl + '/#long' });
  await sleep(3000);

  check('"Load earlier" button shown for older history', await evaluate(`[...document.querySelectorAll('button')].some(b => /Load earlier messages \\(1240 more\\)/.test(b.textContent))`));
  check('answer avatar is the model mark, not a robot', await evaluate(`!!document.querySelector('[title^="Claude"]') && !document.querySelector('.bg-primary .lucide-bot')`));
  check('ring is not spinning', await evaluate(`!document.querySelector('[aria-label="Context"] .animate-spin')`));

  // Ctrl+F with a real key event
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 });
  await sleep(300);
  check('Ctrl+F opens search', await evaluate(`document.activeElement?.placeholder === 'Search this chat…'`));
  await send('Input.insertText', { text: 'Message 400:' });
  await sleep(600);
  const count = await evaluate(`[...document.querySelectorAll('[role=search] span')].map(s => s.textContent).find(t => /\\d+ \\/ \\d+/.test(t))`);
  check('finds a message far up the chat', count === '1 / 1', count);
  check('scrolled to it and highlighted it', await evaluate(`(() => { const el = document.querySelector('.search-current'); if (!el) return false; const r = el.getBoundingClientRect(); return el.innerText.includes('Message 400:') && r.top > 0 && r.bottom < innerHeight; })()`));
  fs.writeFileSync(path.join(outDir, '8-search.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  // many matches + Enter to step
  await evaluate(`(() => { const i = document.querySelector('[role=search] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await send('Input.insertText', { text: 'step 49' });
  await sleep(500);
  const first = await evaluate(`[...document.querySelectorAll('[role=search] span')].map(s => s.textContent).find(t => /\\d+ \\/ \\d+/.test(t))`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(400);
  const second = await evaluate(`[...document.querySelectorAll('[role=search] span')].map(s => s.textContent).find(t => /\\d+ \\/ \\d+/.test(t))`);
  check('Enter moves to the next match', first?.startsWith('1 /') && second?.startsWith('2 /'), `${first} → ${second}`);
  check('still only a few rows mounted', (await evaluate(`document.querySelectorAll('[data-index]').length`)) < 40);

  console.log(results.join('\n'));
  console.log(errors.length ? 'errors: ' + errors.join(' | ') : 'no JS errors');
  ws.close();
})();
