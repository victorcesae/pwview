// In the pwview browser: the multi-project chat (#multi) — rail with context, changes per project and PRs,
// plus the plan-usage ring. Usage: node build/demo-multi.cjs <port> <baseUrl> <outDir>
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
  const shot = async (name) => fs.writeFileSync(path.join(outDir, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const click = (sel) => evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); return true; })()`);
  const results = [];
  const check = (name, ok, detail = '') => results.push(`${ok ? '✔' : '✖'} ${name}${detail ? '  (' + detail + ')' : ''}`);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await send('Page.navigate', { url: baseUrl + '/#multi' });
  await sleep(3000);
  await shot('multi-1-chat.png');
  check('no model reported yet: avatar is still the Claude mark', await evaluate(`[...document.querySelectorAll('[role=img]')].some(e => e.getAttribute('aria-label') === 'Claude') && ![...document.querySelectorAll('[role=img]')].some(e => e.getAttribute('aria-label') === 'Model')`));
  check('answers carry no small editor badge', await evaluate(`!document.querySelector('.ring-background.absolute')`));
  check('context gauge in the right rail', await evaluate(`!!document.querySelector('aside [role=progressbar]')`));
  const changesLabel = await evaluate(`document.querySelector('aside button[aria-label^="Changes"]')?.getAttribute('aria-label')`);
  check('changes button counts 7 files in 3 projects', changesLabel === 'Changes in 3 projects (7)', changesLabel);
  check('PR button counts 3 PRs', (await evaluate(`document.querySelector('aside button[aria-label^="Pull requests"]')?.getAttribute('aria-label')`)) === 'Pull requests (3)');
  check('ring by the input is plan usage', !!(await evaluate(`document.querySelector('button[aria-label^="Plan usage"]')?.getAttribute('aria-label')`)));

  await click('aside button[aria-label^="Changes"]');
  await sleep(500);
  const groups = await evaluate(`[...document.querySelectorAll('[data-radix-popper-content-wrapper] .font-medium')].map(e => e.textContent)`);
  check('grouped by project, own project first', JSON.stringify(groups) === JSON.stringify(['intranet-v5', 'api-gateway', 'shared-ui']), JSON.stringify(groups));
  await shot('multi-2-changes.png');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);

  await click('aside button[aria-label^="Pull requests"]');
  await sleep(500);
  const rows = await evaluate(`[...document.querySelectorAll('[data-radix-popper-content-wrapper] a')].map(a => [a.querySelector('svg').getAttribute('aria-label'), a.querySelector('svg').classList.contains('lucide-git-merge') ? 'merge' : a.querySelector('svg').classList.contains('lucide-git-pull-request-closed') ? 'closed' : 'pr', a.textContent])`);
  check('PR rows show their status and icon', JSON.stringify(rows.map((r) => r.slice(0, 2))) === JSON.stringify([['Merged', 'merge'], ['Closed', 'closed'], ['Open', 'pr']]), JSON.stringify(rows.map((r) => r[0])));
  check('PR rows show titles', rows[0][2].includes('Rename quote status to approvalStatus'));
  check('rail button uses the newest PR state (open, green)', await evaluate(`(() => { const s = document.querySelector('aside button[aria-label^="Pull requests"] svg'); return s.classList.contains('lucide-git-pull-request') && s.style.color.includes('--recent'); })()`));
  await shot('multi-3-prs.png');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);

  await click('button[aria-label^="Plan usage"]');
  await sleep(500);
  check('plan usage panel lists windows', (await evaluate(`document.querySelectorAll('[data-radix-popper-content-wrapper] [role=progressbar]').length`)) === 3);
  await shot('multi-4-usage.png');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  await click('aside button[aria-label="Context"]');
  await sleep(500);
  check('context panel opens from the rail', await evaluate(`!!document.querySelector('[aria-label="Context window map"]')`));
  await shot('multi-5-context.png');

  console.log(results.join('\n'));
  console.log(errors.length ? 'errors: ' + errors.join(' | ') : 'no JS errors');
  ws.close();
})();
