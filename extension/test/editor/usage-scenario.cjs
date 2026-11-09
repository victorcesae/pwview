// What a developer does on a normal day. Each step reports what it saw.
module.exports = async ({ page, wait, shot, palette, quickPickRows, chatFrame, note, ws, fs, path }) => {
  await shot('01-window');
  // the Sessions view and its Tab status item
  await palette('Steerhouse: Focus on Sessions View').catch(() => {});
  await wait(1200);
  await shot('02-sessions');
  note((await page.locator('.statusbar-item', { hasText: 'Tab' }).count()) > 0, 'status bar has the Tab item');
  await page.locator('.pane-header', { hasText: 'Sessions' }).first().hover().catch(() => {});
  await wait(300);
  note((await page.locator('.pane-header a.action-label[aria-label*="Get Started"]').count()) > 0, 'Sessions view has the Get Started button');

  // new chat: two repositories, so it must ask
  await palette('Steerhouse: New Chat');
  await wait(600);
  const rows = await quickPickRows();
  note(await page.evaluate(() => document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('.quick-input-widget')), 'the picker has the keyboard (the guide did not steal it)');
  await shot('03-folder-picker');
  note(rows.some((r) => /alpha/.test(r)) && rows.some((r) => /beta/.test(r)), `folder picker lists the repos: ${JSON.stringify(rows.map((r) => r.split('\n')[0])).slice(0, 120)}`);
  await page.keyboard.type('beta');
  await wait(400);
  await page.keyboard.press('Enter');
  await wait(1200);
  const agents = await quickPickRows();
  await shot('04-agent-picker');
  console.log('  agent rows:', JSON.stringify(agents.map((r) => r.split('\n')[0])).slice(0, 200));
  if (agents.length) await page.keyboard.press('Enter');
  const chat = await chatFrame();
  await wait(2500);
  await shot('05-chat-open');

  // the badge: VS Code's logo or letters?
  const badge = await chat.locator('[aria-label="VS Code"], img[alt="VS Code"]').count();
  note(badge > 0, 'the editor badge in the chat shows the VS Code mark');

  const box = chat.locator('.rich-input');
  await box.click();
  // Shift+Enter
  await page.keyboard.type('line one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('__init__.py and my_file');
  await wait(300);
  await shot('06-typed');
  const typed = await box.innerText();
  note(/line one\n+__init__\.py and my_file/.test(typed), `the box keeps what was typed: ${JSON.stringify(typed)}`);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');

  // @ completion
  await page.keyboard.type('@my_');
  await wait(1200);
  const popup = await chat.locator('button', { hasText: 'my_file.ts' }).count();
  await shot('07-at-completion');
  note(popup > 0, '@ finds my_file.ts in the chosen repository');
  if (popup) {
    await page.keyboard.press('Tab');
    await wait(300);
    note(/my_file\.ts/.test(await box.innerText()), 'Tab inserts it');
  }
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');

  // ! command
  await page.keyboard.type('!');
  await wait(200);
  await page.keyboard.type('pwd; ls');
  await wait(300);
  await shot('08-shell-typing');
  await page.keyboard.press('Enter');
  await wait(1800);
  await shot('09-shell-result');
  const shellBox = chat.locator('[data-shell]');
  note((await shellBox.count()) > 0, '! shows its command box');
  const output = (await shellBox.first().innerText().catch(() => '')) || '';
  note(/\/beta/.test(output) && /my_file\.ts/.test(output), `! ran in the chosen repo: ${JSON.stringify(output.slice(0, 120))}`);

  // Add to Chat with a file open
  await palette('Go to File');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+P');
  await wait(400);
  await page.keyboard.type('beta/my_file.ts');
  await wait(900);
  await page.keyboard.press('Enter');
  await wait(1200);
  await palette('Steerhouse: Add to Chat');
  await wait(1200);
  await shot('10-add-to-chat');
  const again = await chatFrame();
  note(/my_file\.ts/.test(await again.locator('.rich-input').innerText()), 'Add to Chat puts the file in the prompt');
  await again.locator('.rich-input').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');

  // Tab completion toggle in + menu, Live Browser, code completion status
  await palette('Steerhouse: Turn Code Completion On or Off');
  await wait(800);
  await shot('11-code-completion-toggle');
  await page.keyboard.press('Escape');
  await wait(300);
  await palette('Steerhouse: Open Live Browser');
  await wait(9000);
  await shot('12-live-browser');
  const notif = await page.locator('.notification-toast').allInnerTexts();
  console.log('  notifications:', JSON.stringify(notif).slice(0, 300));
  const tabs = await page.locator('.tab .label-name').allInnerTexts();
  note(tabs.some((t) => /Browser/.test(t)), `Live Browser tab opened: ${JSON.stringify(tabs).slice(0, 140)}`);
  await palette('Steerhouse: Stop Live Browser');
  await wait(1500);
  await shot('13-end');
  void fs; void path; void ws;
};
