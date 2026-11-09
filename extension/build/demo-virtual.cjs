// In the pwview browser: load the 2,000-message chat, count rendered rows and JS heap, scroll,
// open the context panel and save screenshots. Usage: node build/demo-virtual.cjs <cdpPort> <outDir> <baseUrl>
const fs = require('fs');
const path = require('path');
const [port, outDir, baseUrl] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
fs.mkdirSync(outDir, { recursive: true });
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
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, 'base64'));
    console.log('saved', name);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: baseUrl + '/#long' });
  await sleep(3000);
  const m1 = await evaluate(`({ rows: document.querySelectorAll('[data-index]').length, nodes: document.getElementsByTagName('*').length, heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576) })`);
  console.log('2,000-message chat, at the bottom:', JSON.stringify(m1));
  await evaluate(`(() => { const s = [...document.querySelectorAll('div')].find(d => getComputedStyle(d).overflowY === 'auto' && d.scrollHeight > d.clientHeight); s.scrollTop = s.scrollHeight / 2; })()`);
  await sleep(800);
  const m2 = await evaluate(`({ rows: document.querySelectorAll('[data-index]').length, first: Math.min(...[...document.querySelectorAll('[data-index]')].map(e => +e.dataset.index)) })`);
  console.log('after scrolling to the middle:', JSON.stringify(m2));
  await shot('5-long-chat-middle.png');

  await send('Page.navigate', { url: baseUrl + '/#chat' });
  await sleep(2500);
  await evaluate(`document.querySelector('[aria-label="Context"]')?.click()`);
  await sleep(700);
  await shot('6-context-panel.png');
  console.log(errors.length ? 'errors: ' + errors.join(' | ') : 'no JS errors');
  ws.close();
})();
