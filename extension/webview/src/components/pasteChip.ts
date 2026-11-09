// Long pastes become a compact chip "[Pasted text #1 +20 lines]" (like Claude Code's terminal).
// The agent still receives the full text. Pasting the same text again, or clicking the chip,
// expands it into the editor. Undo (Ctrl+Z) works for both, through the editor history.
import { mergeAttributes, Node, type Editor } from '@tiptap/core';

/** Pastes bigger than this collapse into a chip. */
export const isLongPaste = (text: string) => text.split(/\r?\n/).length > 5 || text.length > 800;

export const chipLabel = (n: number, lines: number) => `[Pasted text #${n} +${lines} lines]`;

export const PasteChip = Node.create({
  name: 'pasteChip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      n: { default: 1 },
      lines: { default: 0 },
      text: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-paste-chip]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-paste-chip': '', class: 'paste-chip', title: 'Click (or paste again) to expand' }), chipLabel(node.attrs.n, node.attrs.lines)];
  },

  renderText({ node }) {
    return node.attrs.text;
  },

  // tiptap-markdown: the message sent to the agent contains the real text, not the label
  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (s: string) => void }, node: { attrs: { text: string } }) {
          state.write(node.attrs.text);
        },
        parse: {},
      },
    };
  },
});

/** Editor content for raw text: lines joined with hard breaks (keeps code exactly as pasted). */
export function textContent(text: string) {
  const out: object[] = [];
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      if (i > 0) out.push({ type: 'hardBreak' });
      if (line) out.push({ type: 'text', text: line });
    });
  return out;
}

/** Find the chip that holds exactly this text (most recent first). */
export function findChip(editor: Editor, text: string): { pos: number; size: number } | undefined {
  let found: { pos: number; size: number } | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'pasteChip' && node.attrs.text === text) found = { pos, size: node.nodeSize };
  });
  return found;
}

/** Replace a chip with its text. */
export function expandChip(editor: Editor, at: { pos: number; size: number }, text: string) {
  editor.chain().focus().insertContentAt({ from: at.pos, to: at.pos + at.size }, textContent(text)).run();
}

let counter = 0;
/** Insert a chip at the cursor for a long paste. */
export function insertChip(editor: Editor, text: string) {
  counter += 1;
  editor
    .chain()
    .focus()
    .insertContent([{ type: 'pasteChip', attrs: { n: counter, lines: text.replace(/\r\n/g, '\n').split('\n').length, text } }, { type: 'text', text: ' ' }])
    .run();
}
