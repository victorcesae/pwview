// In the pwview browser: paste long text (chip), paste again (expand), Ctrl+Z / Ctrl+Y, typing + undo,
// and what gets sent to the agent. Usage: node build/demo-paste.cjs <cdpPort> <baseUrl> <outDir>
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
  const sent = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) pending.get(m.id)(m.result ?? m.error), pending.delete(m.id);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.args[0]?.value === '[dev] would send to extension:') sent.push(m.params.args[1]);
  };
  const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
  const key = async (k, code, vk, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(150);
  };
  const ctrl = 2;
  const editorText = () => evaluate(`document.querySelector('.rich-input').innerText`);
  const paste = (text) => evaluate(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)}); document.querySelector('.rich-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  const results = [];
  const check = (name, ok, detail = '') => results.push(`${ok ? '✔' : '✖'} ${name}${detail ? '  (' + detail + ')' : ''}`);

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: baseUrl + '/#chat' });
  await sleep(2500);
  // the sample chat is "working": make it idle so Enter sends instead of steering
  await evaluate(`document.querySelector('.rich-input').focus()`);
  await sleep(200);

  const code = Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');

  // 1) long paste -> chip
  await paste(code);
  await sleep(300);
  let txt = await editorText();
  check('long paste becomes a chip', /\[Pasted text #\d+ \+20 lines\]/.test(txt) && !txt.includes('line7'), txt.slice(0, 40));
  fs.writeFileSync(path.join(outDir, '7-paste-chip.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 560, width: 1100, height: 220, scale: 1 } })).data, 'base64'));

  // 2) Ctrl+Z removes the chip, Ctrl+Y brings it back
  await key('z', 'KeyZ', 90, ctrl);
  txt = await editorText();
  check('Ctrl+Z undoes the paste', !/Pasted text/.test(txt), JSON.stringify(txt.trim()));
  await key('y', 'KeyY', 89, ctrl);
  txt = await editorText();
  check('Ctrl+Y redoes it', /Pasted text/.test(txt));

  // 3) pasting the same text again expands the chip into the real text
  await paste(code);
  await sleep(300);
  txt = await editorText();
  check('Ctrl+V again expands to the real text', txt.includes('const line7 = 7;') && !/Pasted text/.test(txt));
  await key('z', 'KeyZ', 90, ctrl);
  txt = await editorText();
  check('Ctrl+Z goes back to the chip', /Pasted text/.test(txt) && !txt.includes('line7'));

  // 4) typing + undo
  await send('Input.insertText', { text: ' please review' });
  await sleep(200);
  txt = await editorText();
  check('typed text appears', txt.includes('please review'));
  await key('z', 'KeyZ', 90, ctrl);
  txt = await editorText();
  check('Ctrl+Z undoes the typing', !txt.includes('please review') && /Pasted text/.test(txt));

  // 5) what the agent receives: the full text, not the label
  await send('Input.insertText', { text: ' check this' });
  await key('Enter', 'Enter', 13, ctrl); // Ctrl+Enter = send now (the sample chat is working)
  await sleep(400);
  const msg = sent.find((m) => m.preview?.properties?.some((p) => p.name === 'type' && p.value === 'send')) ?? sent.at(-1);
  const sentText = msg?.preview?.properties?.find((p) => p.name === 'text')?.value ?? '';
  check('sent message contains the full pasted text', sentText.includes('const line1 = 1;') && !sentText.includes('Pasted text'), sentText.slice(0, 60).replace(/\n/g, '⏎'));
  check('editor is cleared after sending', !(await editorText()).trim());

  console.log(results.join('\n'));
  console.log(errors.length ? 'errors: ' + errors.join(' | ') : 'no JS errors');
  ws.close();
})();
