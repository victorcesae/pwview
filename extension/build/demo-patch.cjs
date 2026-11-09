// In the pwview browser: send the chat a full load, then incremental patches (like the extension
// does), and check the page shows the merged result. Usage: node build/demo-patch.cjs <cdpPort> <baseUrl>
const [port, baseUrl] = [Number(process.argv[2]), process.argv[3]];
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
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: baseUrl + '/#chat' });
  await sleep(2500);

  const base = `{ key: 'k', cwd: '/r', title: 'Patch test', models: [], permissionMode: 'default', fastMode: false, ultracode: false, status: 'working', activity: 'Writing…', todos: [], queue: [], slashCommands: [], mcp: [], costUsd: 0, account: { name: 'Default' } }`;
  const has = (txt) => evaluate(`document.body.innerText.includes(${JSON.stringify(txt)})`);
  const results = [];
  const check = async (name, cond) => results.push(`${(await cond) ? '✔' : '✖'} ${name}`);

  // 1) full load
  await evaluate(`window.postMessage({ type: 'data', data: { view: 'chat', linked: [], chat: { ...${base}, items: [{ kind: 'user', id: 'u1', text: 'first question', images: [], ts: '' }, { kind: 'assistant', id: 'a1', text: 'Hel', streaming: true }] } } }, '*')`);
  await sleep(400);
  await check('full load shows both items', (async () => (await has('first question')) && (await has('Hel')))());
  // 2) patch: the streaming answer grows (only that item is sent)
  await evaluate(`window.postMessage({ type: 'chatPatch', chat: ${base}, upserts: [{ kind: 'assistant', id: 'a1', text: 'Hello from a patch', streaming: true }] }, '*')`);
  await sleep(300);
  await check('changed item is updated in place', has('Hello from a patch'));
  await check('untouched item is kept', has('first question'));
  // 3) patch: a new item + new order + finished status
  await evaluate(`window.postMessage({ type: 'chatPatch', chat: { ...${base}, status: 'idle', title: 'Patched title' }, upserts: [{ kind: 'assistant', id: 'a1', text: 'Hello from a patch', streaming: false }, { kind: 'user', id: 'u2', text: 'second question', images: [], ts: '' }], order: ['u1', 'a1', 'u2'] }, '*')`);
  await sleep(300);
  await check('new item appears in order', evaluate(`document.body.innerText.indexOf('second question') > document.body.innerText.indexOf('Hello from a patch')`));
  await check('chat fields (title) update', has('Patched title'));
  const count = await evaluate(`(document.body.innerText.match(/Hello from a patch/g) || []).length`);
  await check('no duplicated answer', Promise.resolve(count === 1));
  console.log(results.join('\n'));
  console.log(errors.length ? 'errors: ' + errors.join(' | ') : 'no JS errors');
  ws.close();
})();
