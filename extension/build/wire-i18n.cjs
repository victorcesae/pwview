// One-off codemod: route visible UI strings through t() and pass the editor language to webviews.
const fs = require('fs');
let missing = 0;
function edit(file, pairs, importLine) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) {
      console.warn(`  (skip) ${file}: ${a.slice(0, 60)}`);
      missing++;
      continue;
    }
    s = s.split(a).join(b);
  }
  if (importLine && !s.includes(importLine)) s = s.replace(/(import [^\n]+\n)(?!import)/, `$1${importLine}\n`);
  fs.writeFileSync(file, s);
}
const T = (en) => `{t('${en.replace(/'/g, "\\'")}')}`;

edit(
  'webview/src/views/Chat.tsx',
  [
    ["later: { label: 'Queue', icon: ListOrdered, hint: 'Sent when the current turn ends' }", "later: { label: t('Queue'), icon: ListOrdered, hint: t('Sent when the current turn ends') }"],
    ["next: { label: 'Steer', icon: Navigation, hint: 'Picked up at its next step, without stopping' }", "next: { label: t('Steer'), icon: Navigation, hint: t('Picked up at its next step, without stopping') }"],
    ["now: { label: 'Send now', icon: Zap, hint: 'Sent immediately' }", "now: { label: t('Send now'), icon: Zap, hint: t('Sent immediately') }"],
    ["{ value: 'default', label: 'Ask before acting' }", "{ value: 'default', label: t('Ask before acting') }"],
    ["{ value: 'acceptEdits', label: 'Accept edits' }", "{ value: 'acceptEdits', label: t('Accept edits') }"],
    ["{ value: 'plan', label: 'Plan mode' }", "{ value: 'plan', label: t('Plan mode') }"],
    ["{ value: 'auto', label: 'Auto' }", "{ value: 'auto', label: t('Auto') }"],
    ["{ value: 'bypassPermissions', label: 'Bypass permissions' }", "{ value: 'bypassPermissions', label: t('Bypass permissions') }"],
    ['<span className="font-medium">Plan</span>', `<span className="font-medium">${T('Plan')}</span>`],
    ['          {done}/{todos.length} done', "          {t('{0}/{1} done', done, todos.length)}"],
    ["{isAgent ? 'Sub-agent' : it.name}", "{isAgent ? t('Sub-agent') : it.name}"],
    ["{shell ? 'Command' : 'Input'}", "{shell ? t('Command') : t('Input')}"],
    ['uppercase">Output</div>', `uppercase">${T('Output')}</div>`],
    ['                    Open file\n', `                    ${T('Open file')}\n`],
    ['<FileDiff /> Open diff', `<FileDiff /> ${T('Open diff')}`],
    ['{pending ? `Allow ${it.tool}?` : `${it.tool}: ${it.status}`}', "{pending ? t('Allow {0}?', it.tool) : `${it.tool}: ${it.status}`}"],
    ['<Check /> Allow\n', `<Check /> ${T('Allow')}\n`],
    ['                Always allow\n', `                ${T('Always allow')}\n`],
    ['placeholder="or tell it what to do instead…"', "placeholder={t('or tell it what to do instead…')}"],
    ['<Ban /> Deny', `<Ban /> ${T('Deny')}`],
    ['<span className="font-medium">Proposed plan</span>', `<span className="font-medium">${T('Proposed plan')}</span>`],
    ['<Check /> Approve and start', `<Check /> ${T('Approve and start')}`],
    ['placeholder="What should change in the plan?"', "placeholder={t('What should change in the plan?')}"],
    ['              Keep planning\n', `              ${T('Keep planning')}\n`],
    ['placeholder="Other…"', "placeholder={t('Other…')}"],
    ['<Send /> Answer', `<Send /> ${T('Answer')}`],
    ['          Image\n', `          ${T('Image')}\n`],
    ["{!chat.effort && <option value=\"\">Effort: default</option>}", "{!chat.effort && <option value=\"\">{t('Effort: default')}</option>}"],
    ['<option key={e} value={e}>Effort: {e}</option>', "<option key={e} value={e}>{t('Effort: {0}', e)}</option>"],
    ['<Zap className="size-3" /> Fast', `<Zap className="size-3" /> ${T('Fast')}`],
    ['<Square className="fill-current" /> Stop', `<Square className="fill-current" /> ${T('Stop')}`],
    ['<Send /> Send\n', `<Send /> ${T('Send')}\n`],
    ["placeholder={working ? 'Message the agent while it works…  (Enter queues it, Ctrl+Enter sends now)' : 'Ask, plan, or give a task…  (/ for commands, paste or drop images)'}", "placeholder={working ? t('Message the agent while it works…  (Enter queues it, Ctrl+Enter sends now)') : t('Ask, plan, or give a task…  (/ for commands, paste or drop images)')}"],
    ['<Link2 /> Link session', `<Link2 /> ${T('Link session')}`],
    ['text-[11px]">Linked:</span>', `text-[11px]">${T('Linked:')}</span>`],
    ['<div className="text-foreground text-[15px] font-medium">What should we build?</div>', `<div className="text-foreground text-[15px] font-medium">${T('What should we build?')}</div>`],
    ['<RotateCcw /> Try again', `<RotateCcw /> ${T('Try again')}`],
    ['opacity-70">Esc to stop</span>', `opacity-70">${T('Esc to stop')}</span>`],
    ['shrink-0 text-[11px]">queued</span>', `shrink-0 text-[11px]">${T('queued')}</span>`],
    ['<Navigation /> Steer', `<Navigation /> ${T('Steer')}`],
    ['<Zap /> Send now', `<Zap /> ${T('Send now')}`],
  ],
  "import { t } from '@/i18n';",
);

edit(
  'webview/src/views/Overview.tsx',
  [
    ['>Agent sessions</h1>', `>${T('Agent sessions')}</h1>`],
    ['<Plus /> New session', `<Plus /> ${T('New session')}`],
    ['<Link2 className="text-warn size-4" /> Linked changes', `<Link2 className="text-warn size-4" /> ${T('Linked changes')}`],
    ['              {v}\n', "              {v === 'list' ? t('List') : t('Graph')}\n"],
  ],
  "import { t } from '@/i18n';",
);

edit(
  'webview/src/views/Session.tsx',
  [
    ['<MessageSquarePlus /> Message / steer', `<MessageSquarePlus /> ${T('Message / steer')}`],
    ['<Link2 /> Link\n', `<Link2 /> ${T('Link')}\n`],
    ['<SquareTerminal /> Open in chat', `<SquareTerminal /> ${T('Open in chat')}`],
    ['<TabsTrigger value="activity">Activity</TabsTrigger>', `<TabsTrigger value="activity">${T('Activity')}</TabsTrigger>`],
    ['<TabsTrigger value="changes">Changes ', `<TabsTrigger value="changes">${T('Changes')} `],
    ['<TabsTrigger value="agents">Sub-agents ', `<TabsTrigger value="agents">${T('Sub-agents')} `],
    ['            Messages {pending', `            ${T('Messages')} {pending`],
    ['<Stat icon={FileCode2} label="edits"', "<Stat icon={FileCode2} label={t('edits')}"],
    ['<Stat icon={Files} label="files changed"', "<Stat icon={Files} label={t('files changed')}"],
    ['<Stat icon={Wrench} label="tool calls"', "<Stat icon={Wrench} label={t('tool calls')}"],
    ['<Stat icon={Bot} label="sub-agents"', "<Stat icon={Bot} label={t('sub-agents')}"],
    ['<BookmarkPlus className="size-3" /> Save as prompt', `<BookmarkPlus className="size-3" /> ${T('Save as prompt')}`],
  ],
  "import { t } from '@/i18n';",
);

edit('webview/src/components/common.tsx', [["export const stateLabel: Record<State, string> = { working: 'Working', recent: 'Waiting', idle: 'Idle' };", "export const stateLabel: Record<State, string> = { working: t('Working'), recent: t('Waiting'), idle: t('Idle') };"]], "import { t } from '@/i18n';");

// the editor's language goes on <html lang> so the webview knows what to show
for (const f of ['src/panel.ts', 'src/chatPanel.ts']) edit(f, [['<html lang="en">', '<html lang="${vscode.env.language}">']]);
console.log(missing ? `done, ${missing} skipped` : 'done');
