// A real agent, a real reload: what happens to a running command when the window reloads.
module.exports = async ({ page, wait, shot, palette, quickPickRows, chatFrame, note, ws, fs, path, os }) => {
  await wait(8000); // the extension finishes starting
  await palette('Steerhouse: New Chat');
  const title = page.locator('.quick-input-widget:visible .quick-input-title', { hasText: 'New chat' });
  await title.waitFor({ timeout: 20000 }).catch(() => note(false, 'the folder picker appears'));
  await shot('a0-folder');
  // with the mouse, as a person does
  await page.locator('.quick-input-widget:visible .monaco-list-row', { hasText: '/beta' }).first().click();
  const agent = page.locator('.quick-input-widget:visible .monaco-list-row', { hasText: 'Claude' }).first();
  await agent.waitFor({ timeout: 20000 }).catch(() => note(false, 'the agent picker appears'));
  await wait(300);
  await shot('a0-agent');
  console.log('  agent rows:', JSON.stringify(await quickPickRows()).slice(0, 180));
  await agent.click();
  await wait(2000);
  let chat = await chatFrame();
  await wait(2500);
  await chat.locator('.rich-input').click();
  const marker = path.join(ws, 'beta', 'marker.txt');
  await page.keyboard.type(`Use the Bash tool, in the foreground (no background flag), to run exactly this once: node -e "console.log('started');setTimeout(()=>{console.log('ended');require('fs').writeFileSync('marker.txt','done')},70000)"`);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Then reply with only the word FINISHED.');
  await page.keyboard.press('Enter');
  const bubble = await chat.locator('.rich-input').innerText();
  note(bubble.trim() === '', 'the box is empty after sending');

  // approve by clicking, the way a person does
  const allow = chat.getByRole('button', { name: /^Allow/ }).first();
  await allow.waitFor({ timeout: 90000 }).catch(() => {});
  await shot('a1-permission');
  note(await allow.isVisible().catch(() => false), 'a permission card appears');
  await allow.click().catch(() => {});
  await wait(6000);
  await shot('a2-running');
  const text = await chat.locator('body').innerText();
  note(!/\\\n/.test(text), 'the sent message shows no backslash from Shift+Enter');

  // the commands panel
  const rail = chat.getByRole('button', { name: /Background commands/ }).first();
  const hasRail = (await rail.count()) > 0;
  let waited = 0;
  while (!(await rail.count()) && waited < 25) {
    await wait(1000);
    waited++;
  }
  note((await rail.count()) > 0, `the running command is in the commands panel (after ${waited}s)`);
  if (await rail.count()) {
    await rail.click().catch(() => {});
    await wait(2500);
    await shot('a3-commands-panel');
    const out = await chat.locator('[data-task-output]').first().innerText().catch(() => '');
    note(/started/.test(out), `the panel shows live output: ${JSON.stringify(out.slice(0, 60))}`);
    const follow = chat.getByRole('button', { name: /Follow in terminal/ }).first();
    if (await follow.count()) {
      await follow.click();
      await wait(2500);
      await shot('a4-follow-terminal');
      const term = await page.locator('.terminal-wrapper.active .xterm-accessibility, .terminal-wrapper .xterm-rows').first().innerText().catch(() => '');
      console.log('  terminal text:', JSON.stringify(term.slice(0, 200)));
      note(!/source .*activate/.test(term), 'nothing typed itself into the follow terminal');
    } else note(false, 'Follow in terminal button is there');
  }
  void hasRail;

  // the moment of truth
  note(!fs.existsSync(marker), 'still running before the reload');
  const relaysDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'steerhouse', 'relays');
  const mine = () => fs.readdirSync(relaysDir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(relaysDir, f), 'utf8')); } catch { return {}; } }).filter((e) => e.cwd === path.join(ws, 'beta')).map((e) => e.pid);
  const before = mine();
  console.log('  relay before reload:', before);
  await palette('Developer: Reload Window');
  await wait(12000);
  const after = mine();
  console.log('  relay after reload:', after);
  note(before.length === 1 && after.length === 1 && before[0] === after[0], 'same Claude Code process after Reload Window');
  chat = await chatFrame();
  await wait(4000);
  await shot('a5-after-reload');
  const shown = await chat.locator('body').innerText();
  note(!/Interrupted|stopped/i.test(shown.slice(-400)), 'the chat does not say it was interrupted');
  note(!fs.existsSync(marker), 'the command is still running after the reload');
  for (let i = 0; i < 90 && !fs.existsSync(marker); i++) await wait(1000);
  note(fs.existsSync(marker), 'the command finished on its own');
  let done = false;
  for (let i = 0; i < 60 && !done; i++) {
    await wait(1000);
    done = /FINISHED/.test(await chat.locator('body').innerText().catch(() => ''));
  }
  await shot('a6-finished');
  note(done, 'the reconnected chat shows the final answer');
  await chat.locator('.rich-input').click();
  note(true, 'done');
};
