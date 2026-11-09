// Prompts (reusable / programmatic prompts) and Skills (Claude Code skills) views.
import { legacyPromptsDir } from './migrate';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { claudeDir } from './paths';
import { runAgent } from './util';

export interface Doc {
  file: string;
  scope: 'project' | 'user';
  name: string;
  meta: Record<string, string>;
  body: string;
}

function readDoc(file: string, scope: Doc['scope'], fallbackName: string): Doc | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const meta: Record<string, string> = {};
  let body = text;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
    body = text.slice(m[0].length);
  }
  body = body.trim();
  return { file, scope, name: meta.name || meta.title || titleFrom(body) || fallbackName, meta, body };
}

/** A prompt's name is its own first line, like an AI-generated session title: nobody types names. */
export function titleFrom(body: string): string {
  const line = body.split(/\r?\n/).map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '';
  const words = line.replace(/\$\{[^}]+\}/g, '…').split(/\s+/).slice(0, 9).join(' ');
  return words.length > 60 ? words.slice(0, 59) + '…' : words;
}

/** Save prompt text as a reusable prompt (from the dashboard timeline). */
export function savePromptText(text: string): string {
  const dir = path.join(claudeDir(), 'steerhouse', 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  const base = slug(titleFrom(text)).slice(0, 50) || 'prompt';
  let file = path.join(dir, `${base}.md`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base}-${i}.md`);
  fs.writeFileSync(file, `---\nmode: interactive\n---\n${text.trim()}\n`);
  return file;
}

const folders = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
const ls = (d: string) => {
  try {
    return fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return [];
  }
};

export function listPrompts(): Doc[] {
  const out: Doc[] = [];
  const scan = (dir: string, scope: Doc['scope']) => {
    for (const f of ls(dir)) if (f.isFile() && f.name.endsWith('.md')) {
      const d = readDoc(path.join(dir, f.name), scope, f.name.replace(/\.md$/, ''));
      if (d) out.push(d);
    }
  };
  folders().forEach((f) => (scan(path.join(f, '.steerhouse', 'prompts'), 'project'), scan(legacyPromptsDir(f), 'project')));
  scan(path.join(claudeDir(), 'steerhouse', 'prompts'), 'user');
  return out;
}

class DocTree implements vscode.TreeDataProvider<Doc> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(
    private list: () => Doc[],
    private kind: 'prompt' | 'skill',
  ) {}
  refresh() {
    this.emitter.fire();
  }
  getChildren(d?: Doc) {
    return d ? [] : this.list();
  }
  getTreeItem(d: Doc): vscode.TreeItem {
    const it = new vscode.TreeItem(d.name);
    it.iconPath = new vscode.ThemeIcon(this.kind === 'prompt' ? (d.meta.mode === 'headless' ? 'run-all' : 'comment-discussion') : 'book');
    it.description = [d.scope, d.meta.mode, d.meta.description].filter(Boolean).join(' · ');
    it.tooltip = new vscode.MarkdownString(`**${d.name}**\n\n\`${d.file}\`\n\n---\n${d.body.slice(0, 800)}`);
    it.contextValue = this.kind;
    it.command = { command: 'steerhouse.openFile', title: 'Open', arguments: [d.file] };
    return it;
  }
}

/** Fill ${file}, ${selection}, ${workspace} from the editor, then ask for any ${input:Question}. */
async function expand(body: string): Promise<string | undefined> {
  const ed = vscode.window.activeTextEditor;
  const ws = folders()[0] ?? '';
  let out = body
    .replace(/\$\{file\}/g, ed ? vscode.workspace.asRelativePath(ed.document.uri) : '')
    .replace(/\$\{selection\}/g, ed ? ed.document.getText(ed.selection) : '')
    .replace(/\$\{workspace\}/g, ws);
  for (const m of [...out.matchAll(/\$\{input:([^}]+)\}/g)]) {
    const v = await vscode.window.showInputBox({ prompt: m[1] });
    if (v === undefined) return;
    out = out.replace(m[0], v);
  }
  return out;
}

export async function runPrompt(d: Doc) {
  const prompt = await expand(d.body);
  if (prompt === undefined) return;
  const cwd = d.scope === 'project' ? path.resolve(path.dirname(d.file), '..', '..') : folders()[0] ?? os.homedir();
  const args = d.meta.model ? ['--model', d.meta.model] : [];
  if (d.meta.mode === 'headless') runAgent(`⚡ ${d.name}`, cwd, [...args, '-p', prompt]);
  else runAgent(`${d.name}`, cwd, [...args, prompt]);
}

async function pickScope(): Promise<Doc['scope'] | undefined> {
  if (!folders().length) return 'user';
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Project', description: 'committed with this repo, shared with the team', scope: 'project' as const },
      { label: 'Personal', description: 'only you, every project', scope: 'user' as const },
    ],
    { placeHolder: 'Where should it live?' },
  );
  return pick?.scope;
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function createFile(file: string, content: string) {
  if (fs.existsSync(file)) {
    vscode.window.showWarningMessage(`${file} already exists.`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

const STARTERS: Record<string, string> = {
  'review-my-changes': `---\ntitle: Review my changes\nmode: interactive\n---\nReview the uncommitted changes in this repo (git diff). Point out bugs, missing edge cases and anything that breaks existing behaviour. Be concrete: file, line, why, and the fix.\n`,
  'tests-for-this-file': `---\ntitle: Write tests for this file\nmode: interactive\n---\nWrite tests for \${file} using the test framework this project already uses. Cover the main paths and the edge cases, run them, and fix anything that fails.\n`,
  'explain-selection': `---\ntitle: Explain the selection\nmode: headless\n---\nExplain what this code in \${file} does, why it is written this way, and any risks:\n\n\${selection}\n`,
  'fix-the-error': `---\ntitle: Fix this error\nmode: interactive\n---\nI'm getting this error:\n\n\${input:Paste the error}\n\nFind the root cause in this project and fix it. Show me what was wrong before changing anything big.\n`,
  'commit-message': `---\ntitle: Draft a commit message\nmode: headless\n---\nLook at the staged changes (git diff --cached) and write a concise conventional commit message for them. Output only the message.\n`,
};

export function registerLibrary(ctx: vscode.ExtensionContext) {
  const prompts = new DocTree(listPrompts, 'prompt');
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('steerhouse.prompts', prompts),
    vscode.commands.registerCommand('steerhouse.starterPrompts', () => {
      const dir = path.join(claudeDir(), 'steerhouse', 'prompts');
      fs.mkdirSync(dir, { recursive: true });
      let n = 0;
      for (const [name, body] of Object.entries(STARTERS)) {
        const f = path.join(dir, `${name}.md`);
        if (!fs.existsSync(f)) {
          fs.writeFileSync(f, body);
          n++;
        }
      }
      prompts.refresh();
      vscode.window.showInformationMessage(`Steerhouse: added ${n} starter prompts to your personal prompts. Edit them freely.`);
    }),
    vscode.commands.registerCommand('steerhouse.openFile', (f: string) => vscode.window.showTextDocument(vscode.Uri.file(f))),
    vscode.commands.registerCommand('steerhouse.runPrompt', (d?: Doc) => d && runPrompt(d)),
    vscode.commands.registerCommand('steerhouse.newPrompt', async () => {
      const scope = await pickScope();
      if (!scope) return;
      const dir = scope === 'project' ? path.join(folders()[0], '.steerhouse', 'prompts') : path.join(claudeDir(), 'steerhouse', 'prompts');
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
      const file = path.join(dir, `prompt-${stamp}.md`);
      // No name to invent: the first line of the prompt becomes its name.
      await createFile(
        file,
        `---\n# interactive: opens a session you can talk to · headless: runs once with -p and exits\nmode: interactive\n# model: opus\n# variables: \${file} \${selection} \${workspace} \${input:Question to ask when run}\n---\n\n`,
      );
      const ed = vscode.window.activeTextEditor;
      if (ed) {
        const end = ed.document.lineAt(ed.document.lineCount - 1).range.end;
        ed.selection = new vscode.Selection(end, end);
      }
      prompts.refresh();
    }),
    vscode.commands.registerCommand('steerhouse.savePrompt', async (text?: string) => {
      if (!text?.trim()) return;
      const file = savePromptText(text);
      prompts.refresh();
      const open = await vscode.window.showInformationMessage(`Saved as prompt "${titleFrom(text)}".`, 'Open');
      if (open) vscode.window.showTextDocument(vscode.Uri.file(file));
    }),
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/.steerhouse/prompts/*.md');
  const again = () => prompts.refresh();
  watcher.onDidCreate(again);
  watcher.onDidDelete(again);
  watcher.onDidChange(again);
  ctx.subscriptions.push(watcher);
}
