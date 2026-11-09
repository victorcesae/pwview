// Minimal stand-in for the `vscode` module so extension code runs under node:test.
class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (l) => (this.listeners.push(l), { dispose() {} });
  }
  fire(v) {
    this.listeners.forEach((l) => l(v));
  }
}
class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
class MarkdownString {
  constructor(v = '') {
    this.value = v;
  }
  appendMarkdown(s) {
    this.value += s;
    return this;
  }
}
const config = { agentCommand: 'claude', agentArgs: [], days: 3, pollSeconds: 3, defaultSurface: 'chat' };
module.exports = {
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  InlineCompletionItem: class { constructor(insertText, range) { this.insertText = insertText; this.range = range; } },
  EventEmitter,
  TreeItem,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p }), joinPath: (u, ...p) => ({ fsPath: [u.fsPath, ...p].join('/') }) },
  workspace: {
    get workspaceFolders() {
      return process.env.TEST_WS ? [{ uri: { fsPath: process.env.TEST_WS } }] : [];
    },
    getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d) }),
    createFileSystemWatcher: () => ({ onDidCreate() {}, onDidDelete() {}, onDidChange() {}, dispose() {} }),
    asRelativePath: (u) => u.fsPath ?? u,
    fs: { delete: async (uri, opts) => (globalThis.__fsDeletes ??= []).push({ path: uri.fsPath, ...opts }) },
  },
  window: { showInformationMessage: async () => undefined, showErrorMessage: async () => undefined, showWarningMessage: async () => undefined, createTerminal: () => ({ show() {}, sendText() {} }) },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
  env: {
    get remoteName() {
      return process.env.TEST_REMOTE_NAME;
    },
  },
  l10n: { t: (s, ...a) => String(s).replace(/\{(\d+)\}/g, (_, i) => String(a[i])) },
};
