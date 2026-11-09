// Renders the Steerhouse icon with the pwview browser: media/steerhouse.png (128, store icon),
// media/steerhouse-256.png, and a preview sheet (sizes, dark and light). Usage: node build/render-icon.cjs <cdpPort> <outDir>
const fs = require('fs');
const path = require('path');
const [port, outDir] = [Number(process.argv[2]), process.argv[3]];
const media = path.join(__dirname, '..', 'media');
const big = fs.readFileSync(path.join(media, 'steerhouse.svg'), 'utf8');
const monoDark = fs.readFileSync(path.join(media, 'steerhouse-dark.svg'), 'utf8');
const monoLight = fs.readFileSync(path.join(media, 'steerhouse-light.svg'), 'utf8');
const uri = (svg) => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) pending.get(m.id)(m.result ?? m.error), pending.delete(m.id);
  };
  const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  const html = (body) => 'data:text/html;base64,' + Buffer.from(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${body}</body></html>`).toString('base64');
  const capture = async (file, w, h, body, transparent) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setDefaultBackgroundColorOverride', transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
    await send('Page.navigate', { url: html(body) });
    await sleep(600);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  };
  await send('Page.enable');
  await capture(path.join(media, 'steerhouse.png'), 128, 128, `<img src="${uri(big)}" width="128" height="128" style="display:block">`, true);
  await capture(path.join(media, 'steerhouse-256.png'), 256, 256, `<img src="${uri(big)}" width="256" height="256" style="display:block">`, true);

  const row = (bg, fg, mono, label) => `
    <div style="background:${bg};color:${fg};padding:18px 22px;display:flex;align-items:center;gap:26px;font:13px Segoe UI,sans-serif">
      <span style="width:70px;opacity:.7">${label}</span>
      <img src="${uri(big)}" width="128"><img src="${uri(big)}" width="64"><img src="${uri(big)}" width="32"><img src="${uri(big)}" width="16">
      <span style="display:inline-flex;align-items:center;gap:6px;border:1px solid ${fg}33;border-radius:6px;padding:5px 10px"><img src="${uri(big)}" width="16"> Steerhouse · Sales module</span>
      <span style="display:inline-flex;flex-direction:column;align-items:center;gap:4px;opacity:.85"><img src="${uri(mono)}" width="24"><small>sidebar</small></span>
    </div>`;
  await capture(
    path.join(outDir, 'steerhouse-icon-preview.png'),
    900,
    360,
    `<div style="font:600 15px Segoe UI,sans-serif;padding:12px 22px;background:#111;color:#eee">Steerhouse: store icon (128/64/32/16), editor tab, sidebar</div>${row('#1e1e1e', '#e6e6e6', monoDark, 'Dark')}${row('#ffffff', '#222', monoLight, 'Light')}`,
    false,
  );
  console.log('rendered');
  ws.close();
})();
