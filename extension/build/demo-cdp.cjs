// Drives the browser that `pwview up` started, over its DevTools port, the same way an agent's
// Playwright run would, and saves what the browser shows. Usage: node build/demo-cdp.cjs <cdpPort> <outDir>
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 9333);
const outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) pending.get(m.id)(m.result ?? m.error), pending.delete(m.id);
  };
  const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, 'base64'));
    console.log('saved', name);
  };
  const click = async (selectorJs) => {
    const box = await evaluate(`(() => { const el = ${selectorJs}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error('not found: ' + selectorJs);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false });

  // 1) the chat
  await send('Page.navigate', { url: 'http://localhost:5180/#chat' });
  await sleep(2500);
  await evaluate("location.reload()");
  await sleep(2500);
  await shot('1-chat.png');

  // 2) open the + menu, then Connectors
  await click(`document.querySelector('[aria-label="Add"]')`);
  await sleep(500);
  await click(`[...document.querySelectorAll('[role=menuitem]')].find(e => e.textContent.includes('Connectors'))`);
  await sleep(600);
  await shot('2-plus-menu-connectors.png');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);

  // 3) the dashboard's Usage view
  await send('Page.navigate', { url: 'http://localhost:5180/' });
  await sleep(2500);
  const usage = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(e => e.textContent.trim().toLowerCase() === 'usage'); if (b) b.click(); return !!b; })()`);
  await sleep(800);
  if (usage) await shot('3-dashboard-usage.png');

  // 4) the graph
  await evaluate(`[...document.querySelectorAll('button')].find(e => e.textContent.trim().toLowerCase() === 'graph')?.click()`);
  await sleep(1200);
  await shot('4-dashboard-graph.png');
  ws.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
