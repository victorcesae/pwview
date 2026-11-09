const fs = require('fs');
const f = 'webview/src/components/RichInput.tsx';
let s = fs.readFileSync(f, 'utf8');
const R = (a, b) => { if (!s.includes(a)) { console.error('MISSING: ' + a.slice(0, 80)); process.exit(1); } s = s.split(a).join(b); };
R("      Markdown.configure({ html: false, transformPastedText: true, breaks: true }),\n    ],", "      Markdown.configure({ html: false, transformPastedText: true, breaks: true }),\n      PasteChip,\n    ],");
R(`        if (files.length && cb.current.onFiles) {
          cb.current.onFiles(files);
          return true;
        }
        return false;
      },
      handleDrop:`, `        if (files.length && cb.current.onFiles) {
          cb.current.onFiles(files);
          return true;
        }
        // long text: a compact chip; the same text pasted again expands the chip (like the terminal)
        const text = event.clipboardData?.getData('text/plain') ?? '';
        const ed = editorRef.current;
        if (ed && text && isLongPaste(text)) {
          const chip = findChip(ed, text);
          if (chip) expandChip(ed, chip, text);
          else insertChip(ed, text);
          return true;
        }
        return false;
      },
      handleClickOn: (_view, _pos, node, nodePos) => {
        const ed = editorRef.current;
        if (ed && node.type.name === 'pasteChip') {
          expandChip(ed, { pos: nodePos, size: node.nodeSize }, node.attrs.text);
          return true;
        }
        return false;
      },
      handleDrop:`);
R("    onUpdate: ({ editor }) => cb.current.onChange?.(md(editor)),\n  });", "    onUpdate: ({ editor }) => cb.current.onChange?.(md(editor)),\n  });\n  const editorRef = useRef<Editor | null>(null);\n  editorRef.current = editor;");
R("import { Markdown } from 'tiptap-markdown';", "import { Markdown } from 'tiptap-markdown';\nimport { expandChip, findChip, insertChip, isLongPaste, PasteChip } from './pasteChip';");
fs.writeFileSync(f, s);
const css = 'webview/src/index.css';
fs.appendFileSync(css, `
/* long-paste chip: [Pasted text #1 +20 lines] */
.rich-input .paste-chip {
  display: inline-block;
  padding: 0 6px;
  margin: 0 1px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--working) 18%, transparent);
  color: var(--working);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.rich-input .paste-chip.ProseMirror-selectednode {
  outline: 1.5px solid var(--ring);
}
`);
console.log('ok');
