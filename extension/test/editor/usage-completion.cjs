// Tab in a real editor, from the real subscription: turn it on by clicking, type, accept. A few tiny Haiku requests.
module.exports = async ({ page, wait, shot, palette, note, ws, fs, path }) => {
  await wait(8000);
  await page.keyboard.press('Control+P');
  await wait(500);
  await page.keyboard.type('beta/my_file.ts');
  await wait(900);
  await page.keyboard.press('Enter');
  await wait(1500);
  // the Tab item in the status bar
  const item = page.locator('.statusbar-item', { hasText: 'Tab' }).first();
  await item.click();
  const rows = page.locator('.quick-input-widget:visible .monaco-list-row');
  await rows.first().waitFor({ timeout: 10000 }).catch(() => note(false, 'the source picker appears'));
  await wait(300);
  const list = await rows.allInnerTexts();
  await shot('c1-sources');
  console.log('  sources:', JSON.stringify(list.map((r) => r.replace(/\n/g, ' '))).slice(0, 240));
  note(/subscription/i.test(list[0] ?? ''), 'the subscription is offered first');
  await rows.first().click();
  await wait(800);
  await shot('c2-warning');
  const on = page.locator('.dialog-buttons a, .dialog-buttons button', { hasText: 'Turn On' }).first();
  note((await on.count()) > 0, 'it warns about plan limits before turning on');
  await on.click().catch(() => {});
  await wait(1200);
  note(/sparkle|codicon/.test((await item.innerHTML().catch(() => ''))), 'the status bar item shows it is on');
  const file = path.join(ws, 'beta', 'my_file.ts');
  await page.locator('.editor-instance .view-lines').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('export function add(a: number, b: number) {\n');
  const started = Date.now();
  let seen = false;
  let ms = 0;
  for (let i = 0; i < 60 && !seen; i++) {
    await wait(250);
    seen = (await page.locator('.ghost-text-decoration, .ghost-text').count()) > 0;
    ms = Date.now() - started;
  }
  await shot('c3-suggestion');
  note(seen, `a gray suggestion appears (after ${ms} ms)`);
  const ghost = await page.locator('.ghost-text-decoration, .ghost-text').allInnerTexts();
  console.log('  suggestion:', JSON.stringify(ghost).slice(0, 160));
  await page.keyboard.press('Tab');
  await wait(600);
  await page.keyboard.press('Control+S');
  await wait(800);
  await shot('c4-accepted');
  const text = fs.readFileSync(file, 'utf8');
  console.log('  file:', JSON.stringify(text).slice(0, 200));
  note(/return/.test(text), 'Tab accepts it into the file');
  const projects = path.join(require('os').homedir(), '.claude', 'projects');
  note(!fs.readdirSync(projects).some((d) => /globalStorage|victorcesae/.test(d)), 'suggestions leave nothing in the session list');
  await item.click();
  await wait(800);
  await shot('c5-off');
};
