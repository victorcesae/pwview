// In the pwview browser: every kind of block in the #multi demo chat, with VS Code's own default
// code styles injected (dim grey <pre>/<code>), must use the normal text colour and not scroll
// sideways (diffs excepted). Usage: node build/demo-blocks.cjs <port> <baseUrl> <outDir>
const fs = require('fs');
const path = require('path');
const [port, baseUrl, outDir] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) pend.get(m.id)(m.result), pend.delete(m.id);
  };
  const send = (method, params = {}) => new Promise((r) => (pend.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  const ev = (x) => send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }).then((r) => r?.result?.value);
  const results = [];
  const check = (name, ok, detail = '') => results.push(`${ok ? '✔' : '✖'} ${name}${detail ? '  (' + detail + ')' : ''}`);
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await send('Page.navigate', { url: baseUrl + '/#multi' });
  await sleep(3000);
  // VS Code's default webview styles come first in <head>: dim preformatted text
  await ev(`(() => { const s = document.createElement('style'); s.textContent = 'code, pre { color: rgb(140, 140, 140); } pre { white-space: pre; }'; document.head.prepend(s); return true; })()`);
  // real mouse clicks (like a user), on the tool group and then on each command row
  const clickAt = async (find) => {
    const p = await ev(`(() => { const b = ${find}; if (!b) return null; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
    if (!p) return false;
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
    await sleep(350);
    return true;
  };
  await clickAt(`[...document.querySelectorAll("button")].find((b) => /^Edited [0-9]+ files/.test(b.textContent.trim()))`);
  const commands = await ev(`[...document.querySelectorAll("button")].filter((b) => /^(cd |gh pr)/.test(b.textContent.trim())).length`);
  for (let i = 0; i < commands; i++) await clickAt(`[...document.querySelectorAll("button")].filter((b) => /^(cd |gh pr)/.test(b.textContent.trim()))[${i}]`);
  await ev(`document.querySelector("pre")?.scrollIntoView({ block: "center" })`);
  await sleep(300);
  const fg = await ev(`getComputedStyle(document.body).color`);
  const blocks = await ev(`JSON.stringify([...document.querySelectorAll('pre, code')].filter(e => e.offsetParent).map(e => ({ tag: e.tagName, color: getComputedStyle(e).color, keep: !!e.closest('.keep-lines'), sideways: e.tagName === 'PRE' && e.scrollWidth > e.clientWidth + 1, text: e.textContent.slice(0, 40) })))`).then(JSON.parse);
  const dim = blocks.filter((b) => b.color === 'rgb(140, 140, 140)');
  const sideways = blocks.filter((b) => b.sideways && !b.keep);
  check(`${blocks.length} code/pre blocks found on screen`, blocks.length >= 8 && blocks.some((b) => /Test Files|github.com/.test(b.text)));
  check('none uses VS Code’s dim code colour', !dim.length, dim.map((b) => b.text).join(' | '));
  check('none scrolls sideways (diffs excepted)', !sideways.length, sideways.map((b) => b.text).join(' | '));
  fs.writeFileSync(path.join(outDir, 'blocks.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log(results.join('\n'));
  console.log('body colour ' + fg);
  ws.close();
})();
