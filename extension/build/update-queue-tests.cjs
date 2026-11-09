// One-off: replace the two queue tests with the undo-window behaviour, add the duplicate test.
const fs = require('fs');
const f = 'test/unit.test.cjs';
const s = fs.readFileSync(f, 'utf8');
const a = s.indexOf("test('chat: Queue holds messages until the turn ends; Steer and Send now go straight in'");
const b = s.indexOf("test('chat: cancel removes a queued message; images become image blocks'");
if (a < 0 || b < 0) throw new Error('markers not found');
const tests = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('chat: Queue waits for the turn end; Steer goes in after a short undo window; Send now at once', async () => {
  const c = newChat();
  c.steerGraceMs = 30;
  c.send('first', [], 'later');
  assert.deepEqual(queued(c).map((m) => m.priority), ['later'], 'idle: sent right away');
  c.input.q.length = 0;
  assert.equal(c.state.status, 'working');

  c.send('queued one', [], 'later');
  c.send('queued two', [], 'later');
  assert.equal(c.state.queue.length, 2, 'working: kept in our queue (editable)');

  c.send('steer this', [], 'next');
  c.send('do it now', [], 'now');
  assert.deepEqual(queued(c).map((m) => m.priority), ['now'], 'send now goes in immediately');
  assert.deepEqual(c.state.queue.map((q) => q.priority), ['later', 'later', 'next'], 'steer is still editable');
  c.input.q.length = 0;

  await sleep(60);
  assert.deepEqual(queued(c).map((m) => [m.priority, m.content.at(-1).text]), [['next', 'steer this']], 'after the undo window the steer goes in');
  assert.deepEqual(c.state.queue.map((q) => q.priority), ['later', 'later']);
  c.input.q.length = 0;

  c.promote(c.state.queue[1].id, 'now');
  assert.deepEqual(queued(c).map((m) => [m.priority, m.content.at(-1).text]), [['now', 'queued two']], 'a queued message can be sent now');
  c.input.q.length = 0;

  h(c, { type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 5, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } });
  assert.deepEqual(queued(c).map((m) => m.content.at(-1).text), ['queued one'], 'turn end delivers the next queued message');
  assert.equal(c.state.queue.length, 0);
  assert.equal(c.state.costUsd, 0.01);
  assert.equal(c.state.tokens, 115);
});

test('chat: within the undo window a steer can be edited, switched or cancelled', async () => {
  const c = newChat();
  c.steerGraceMs = 40;
  c.state.status = 'working';
  c.send('use npm', [], 'next');
  const id = c.state.queue[0].id;
  c.editQueued(id, 'use pnpm');
  c.promote(id, 'later'); // switch Steer -> Queue: no longer goes in by itself
  await sleep(70);
  assert.equal(c.input.q.length, 0, 'switched to Queue: waits for the turn end');
  c.promote(id, 'next'); // back to Steer: a new undo window
  c.editQueued(id, 'use pnpm, not npm');
  await sleep(70);
  assert.deepEqual(queued(c).map((m) => m.content.at(-1).text), ['use pnpm, not npm']);
  c.editQueued(id, 'too late');
  assert.equal(c.input.q[0].message.content.at(-1).text, 'use pnpm, not npm', 'handed-over messages can no longer change');

  c.input.q.length = 0;
  c.send('never mind', [], 'next');
  c.cancelQueued(c.state.queue[0].id);
  await sleep(70);
  assert.equal(c.input.q.length, 0, 'a cancelled steer never goes in');
});

test('chat: a reply split into several messages is not shown twice', () => {
  const c = newChat();
  c.state.status = 'working';
  // streamed: thinking at index 0, text at index 1
  h(c, { type: 'stream_event', event: { type: 'message_start', message: { id: 'r1' } } });
  h(c, { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } });
  h(c, { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'All done.' } } });
  // the CLI then sends the reply as separate assistant messages, text at index 0
  h(c, { type: 'assistant', message: { id: 'r1', content: [{ type: 'thinking', thinking: '' }] } });
  h(c, { type: 'assistant', message: { id: 'r1', content: [{ type: 'text', text: 'All done.' }] } });
  h(c, { type: 'result', subtype: 'success', duration_ms: 1 });
  const texts = c.state.items.filter((i) => i.kind === 'assistant').map((i) => i.text);
  assert.deepEqual(texts, ['All done.']);
  // and the same final text arriving again (re-emitted) is not appended either
  h(c, { type: 'assistant', message: { id: 'r2', content: [{ type: 'text', text: 'All done.' }] } });
  assert.equal(c.state.items.filter((i) => i.kind === 'assistant').length, 1);
});

`;
fs.writeFileSync(f, s.slice(0, a) + tests + s.slice(b));
console.log('ok');
