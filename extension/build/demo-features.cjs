// In the pwview browser, on the #multi demo chat: suggested next prompt (Tab), Up to recall a sent
// prompt, Quote an answer, prompt stash, Edit and run again, PR files with viewed marks and Merge.
// Usage: node build/demo-features.cjs <port> <baseUrl> <outDir>
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
  const key = (key, code, vk, extra = {}) => send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...extra }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }));
  const click = (sel) => evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); return true; })()`);
  const box = () => evaluate(`document.querySelector('.rich-input')?.innerText.trim()`);
  const focusBox = () => evaluate(`(() => { const e = document.querySelector('.rich-input'); e.focus(); return true; })()`);
  const clearBox = async () => (await focusBox(), await key('a', 'KeyA', 65, { modifiers: 2 }), await key('Backspace', 'Backspace', 8));
  const sentMsgs = () => evaluate(`JSON.stringify(window.__devSent ?? [])`).then((s) => JSON.parse(s));
  const results = [];
  const check = (name, ok, detail = '') => results.push(`${ok ? '✔' : '✖'} ${name}${detail ? '  (' + detail + ')' : ''}`);

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 860, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await send('Page.navigate', { url: baseUrl + '/#multi' });
  await sleep(3000);

  // suggestion
  check('suggested next prompt shown', (await evaluate(`document.querySelector('[data-suggestion]')?.textContent`))?.includes('Now update the API docs'));
  await shot('feat-1-suggestion.png');
  await focusBox();
  await key('Tab', 'Tab', 9);
  await sleep(200);
  check('Tab puts the suggestion in the box', (await box()) === 'Now update the API docs for /quotes/:id', await box());

  // Up to recall
  await clearBox();
  await key('ArrowUp', 'ArrowUp', 38);
  await sleep(200);
  check('Up recalls the last prompt you sent', (await box())?.startsWith('Rename the "status" field'), (await box())?.slice(0, 40));
  await key('ArrowDown', 'ArrowDown', 40);
  await sleep(150);
  check('Down past the newest clears the box', (await box()) === '');

  // Quote
  await evaluate(`document.querySelector('[data-quote]').click()`);
  await sleep(200);
  check('Quote puts the answer in the box as a quote', /^This touches three repos/.test(await box()) && (await evaluate(`!!document.querySelector('.rich-input blockquote')`)), (await box())?.slice(0, 40));

  // stash: put the quote aside, bring a stashed prompt back
  await click('[data-stash]');
  await sleep(300);
  check('stash menu lists stashed prompts', (await evaluate(`document.querySelectorAll('[data-stashed]').length`)) === 2);
  await shot('feat-2-stash.png');
  await evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(e => /Stash this prompt/.test(e.textContent)).click()`);
  await sleep(200);
  check('Stash this prompt sends it aside and clears the box', (await sentMsgs()).some((m) => m.type === 'stash' && /This touches three repos/.test(m.text)) && (await box()) === '');
  await click('[data-stash]');
  await sleep(300);
  await evaluate(`document.querySelectorAll('[data-stashed]')[1].click()`);
  await sleep(200);
  check('a stashed prompt comes back into the box', (await box()) === 'Draft the release note' && (await sentMsgs()).some((m) => m.type === 'unstash' && m.index === 1));

  // Edit and run again
  await evaluate(`document.querySelector('[data-edit-prompt]').click()`);
  await sleep(300);
  check('Edit opens the message for editing', await evaluate(`!!document.querySelector('[data-editing] textarea')`));
  await evaluate(`(() => { const t = document.querySelector('[data-editing] textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Rename status to approvalStatus in the API only'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(100);
  await shot('feat-3-edit.png');
  await evaluate(`[...document.querySelectorAll('[data-editing] button')].find(b => /Run again/.test(b.textContent)).click()`);
  await sleep(200);
  const edit = (await sentMsgs()).find((m) => m.type === 'editPrompt');
  check('Run again sends the edited prompt for that message', edit?.id === 'm-u1' && edit.text === 'Rename status to approvalStatus in the API only');

  // PR review and merge
  await click('aside button[aria-label^="Pull requests"]');
  await sleep(400);
  const open = '[data-pr="https://github.com/NZero-Labs/intranet-v5/pull/1288"]';
  await evaluate(`document.querySelector('${open} [data-pr-files]').click()`);
  await sleep(400);
  check('PR files listed with viewed marks', (await evaluate(`document.querySelectorAll('${open} [data-file]').length`)) === 3 && (await evaluate(`document.querySelector('${open} [aria-label="Files changed"]').textContent.includes('0 of 3 viewed')`)));
  await evaluate(`document.querySelector('${open} [data-file] input').click()`);
  await sleep(400);
  check('marking a file viewed updates the count', await evaluate(`document.querySelector('${open} [aria-label="Files changed"]').textContent.includes('1 of 3 viewed')`));
  await shot('feat-4-pr-review.png');
  check('Merge only on the open PR', (await evaluate(`document.querySelectorAll('[data-pr-merge]').length`)) === 1);
  await evaluate(`document.querySelector('${open} [data-pr-merge]').click()`);
  await sleep(200);
  check('Merge asks the extension (which confirms first)', (await sentMsgs()).some((m) => m.type === 'prMerge' && m.url.endsWith('/1288')));

  console.log(results.join('\n'));
  console.log(errors.length ? 'errors: ' + errors.join(' | ') : 'no JS errors');
  ws.close();
})();
