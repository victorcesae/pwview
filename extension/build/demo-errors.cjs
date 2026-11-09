// Reload the page in the pwview browser and print any JavaScript errors it reports.
const port = Number(process.argv[2] || 9333);
const url = process.argv[3] || 'http://localhost:5179/#chat';
(async () => {
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
  send('Runtime.enable');
  send('Page.enable');
  send('Page.navigate', { url: 'about:blank' });
  await new Promise((r) => setTimeout(r, 500));
  send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 4000));
  console.log(errors.length ? errors.map((e) => e.split('\n').slice(0, 4).join('\n')).join('\n---\n') : 'no errors');
  ws.close();
})();
