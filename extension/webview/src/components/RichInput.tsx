// Rich-text prompt input (TipTap). Users type naturally (**bold**, `code`, ``` blocks, - lists,
// # headings become formatting as they type, or use the toolbar) and the agent receives markdown.
import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Code, Italic, List, ListOrdered, SquareCode } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Markdown } from 'tiptap-markdown';
import { expandChip, findChip, insertChip, isLongPaste, PasteChip } from './pasteChip';
import { cn } from '@/lib/utils';

export interface RichInputHandle {
  getMarkdown(): string;
  /** the text exactly as typed, without Markdown escapes */
  getText(): string;
  setMarkdown(md: string): void;
  clear(): void;
  focus(): void;
  isEmpty(): boolean;
}

interface Props {
  placeholder: string;
  /** Enter (outside code blocks and lists) */
  onSubmit: (mod: { ctrl: boolean }) => void;
  onEscape?: () => void;
  onFiles?: (files: File[]) => void;
  onChange?: (markdown: string) => void;
  /** return true when the key was handled (slash-command menu) */
  onKey?: (e: KeyboardEvent) => boolean;
  className?: string;
}

const md = (e: Editor) => ((e.storage as any).markdown?.getMarkdown?.() as string | undefined) ?? e.getText();

export const RichInput = forwardRef<RichInputHandle, Props>(function RichInput({ placeholder, onSubmit, onEscape, onFiles, onChange, onKey, className }, ref) {
  // keep latest callbacks without re-creating the editor
  const cb = useRef({ onSubmit, onEscape, onFiles, onChange, onKey });
  cb.current = { onSubmit, onEscape, onFiles, onChange, onKey };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false }),
      Placeholder.configure({ placeholder }),
      Markdown.configure({ html: false, transformPastedText: true, breaks: true }),
      PasteChip,
    ],
    editorProps: {
      attributes: { class: 'rich-input outline-none min-h-11 max-h-64 overflow-y-auto px-1 py-0.5 text-[13px] leading-relaxed' },
      handleKeyDown: (view, event) => {
        if (cb.current.onKey?.(event)) return true;
        if (event.key === 'Escape') {
          cb.current.onEscape?.();
          return true;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          const { $from } = view.state.selection;
          const inBlock = $from.parent.type.name === 'codeBlock' || $from.node(-1)?.type.name === 'listItem';
          if (inBlock && !(event.ctrlKey || event.metaKey)) return false; // newline / new list item
          event.preventDefault();
          cb.current.onSubmit({ ctrl: event.ctrlKey || event.metaKey });
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
        if (files.length && cb.current.onFiles) {
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
      handleDrop: (_view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
        if (files.length && cb.current.onFiles) {
          event.preventDefault();
          cb.current.onFiles(files);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => cb.current.onChange?.(md(editor)),
  });
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  useEffect(() => {
    if (editor) editor.extensionManager.extensions.find((x) => x.name === 'placeholder')!.options.placeholder = placeholder;
    editor?.view.dispatch(editor.state.tr); // re-render placeholder
  }, [placeholder, editor]);

  useImperativeHandle(ref, () => ({
    getMarkdown: () => (editor ? md(editor).trim() : ''),
    getText: () => editor?.getText({ blockSeparator: '\n' }) ?? '',
    setMarkdown: (m: string) => editor?.commands.setContent(m),
    clear: () => editor?.commands.clearContent(true),
    focus: () => editor?.commands.focus('end'),
    isEmpty: () => !editor || editor.isEmpty,
  }));

  const tool = (label: string, Icon: React.ComponentType<{ className?: string }>, active: boolean, run: () => void) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(e) => {
        e.preventDefault();
        run();
      }}
      className={cn('hover:bg-accent hover:text-foreground grid size-6 cursor-pointer place-items-center rounded', active ? 'bg-accent text-foreground' : 'text-muted-foreground')}
    >
      <Icon className="size-3.5" />
    </button>
  );

  return (
    <div className={cn('flex flex-col', className)}>
      <EditorContent editor={editor} />
      {editor && (
        <div className="flex items-center gap-0.5 pt-1" data-slot="format-toolbar">
          {tool('Bold (Ctrl+B)', Bold, editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
          {tool('Italic (Ctrl+I)', Italic, editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
          {tool('Code (Ctrl+E)', Code, editor.isActive('code'), () => editor.chain().focus().toggleCode().run())}
          {tool('Code block (```)', SquareCode, editor.isActive('codeBlock'), () => editor.chain().focus().toggleCodeBlock().run())}
          {tool('Bullet list (- )', List, editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
          {tool('Numbered list (1. )', ListOrdered, editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
        </div>
      )}
    </div>
  );
});
