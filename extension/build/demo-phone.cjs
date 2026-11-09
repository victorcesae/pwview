// In the pwview browser at phone size: the remote page served by AgentLens with sample sessions.
// Opens the link with its key, checks the key leaves the address bar, lists sessions, opens one,
// sends a Steer message. Usage: node build/demo-phone.cjs <cdpPort> <outDir>   (after npm test built remote.js)
const fs = require('fs');
const os = require('os');
const path = require('path');
const [port, outDir] = [Number(process.argv[2]), process.argv[3]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { RemoteServer } = require(path.join(os.tmpdir(), 'agentlens-remote-build', 'remote.js'));
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
const s = (id, title, state, minAgo, events) => ({ info: { id, title, project: '/home/victor/intranet-v5', state, updated: iso(minAgo), model: 'claude-opus-5-5' }, t: { events } });
const sessions = [
  s('a1', 'Sales module: quotation flow', 'working', 0.2, [
    { ts: iso(9), kind: 'prompt', text: 'Add the approval step before a quote is sent' },
    { ts: iso(8), kind: 'text', text: "I'll gate QuoteService.send on the approval status." },
    { ts: iso(7), kind: 'tool', text: 'Edit apps/api/src/sales/quote.service.ts' },
    { ts: iso(6), kind: 'change', text: 'quote.service.ts +14 −2' },
    { ts: iso(1), kind: 'text', text: 'Now updating the quotes list to show "Awaiting approval".' },
  ]),
  s('a2', 'Database encryption on same server', 'recent', 40, [{ ts: iso(40), kind: 'prompt', text: 'Encrypt the customer table at rest' }]),
  s('a3', 'Contrato MCDSSA em português', 'idle', 600, [{ ts: iso(600), kind: 'prompt', text: 'Traduza o contrato' }]),
];
(async () => {
  const sent = [];
  const srv = new RemoteServer({ sessions: () => sessions, send: async (id, text, mode) => (sent.push({ id, text, mode }), 'steering: delivered at its next step') });
  const p = await srv.start('127.0.0.1');
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page');
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
  const shot = async (name) => fs.writeFileSync(path.join(outDir, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const results = [];
  const check = (name, ok, detail = '') => results.push(`${ok ? '✔' : '✖'} ${name}${detail ? '  (' + detail + ')' : ''}`);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await send('Network.enable');
  await send('Network.clearBrowserCookies');
  await send('Page.navigate', { url: `http://127.0.0.1:${p}/` });
  await sleep(800);
  check('without the key: refused', /open the link with its key/.test(await evaluate('document.body.innerText')));
  await send('Page.navigate', { url: `http://127.0.0.1:${p}/?k=${srv.key}` });
  await sleep(1500);
  check('the key leaves the address bar', (await evaluate('location.href')) === `http://127.0.0.1:${p}/`);
  check('sessions listed, newest first', JSON.stringify(await evaluate(`[...document.querySelectorAll('.s b')].map(b => b.textContent)`)) === JSON.stringify(sessions.map((x) => x.info.title)));
  check('no sideways scrolling on a phone', await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  await shot('phone-1-list.png');
  await evaluate(`document.querySelector('.s').click()`);
  await sleep(1200);
  check('conversation shown', (await evaluate(`document.querySelectorAll('.e').length`)) === 5 && (await evaluate(`document.getElementById('st').textContent`)) === 'working…');
  await evaluate(`(() => { const t = document.getElementById('t'); t.value = 'Also add an e2e test for the approval'; })()`);
  await evaluate(`document.querySelector('.send').click()`);
  await sleep(800);
  check('Steer sent to that session', sent.length === 1 && sent[0].id === 'a1' && sent[0].mode === 'steer', JSON.stringify(sent[0]));
  check('result shown', /steering/.test(await evaluate(`document.getElementById('st').textContent`)));
  await shot('phone-2-session.png');
  console.log(results.join('\n'));
  console.log(errors.length ? 'errors: ' + errors.join(' | ') : 'no JS errors');
  ws.close();
  await srv.stop();
})();
