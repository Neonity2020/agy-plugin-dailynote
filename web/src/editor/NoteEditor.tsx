import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Table, { TableView } from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { EditorContent, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import { uploadAttachment } from '../lib/api';
import { docToMarkdown, isSafeUrl, markdownToDoc, type TiptapNode } from '../lib/markdownCodec';
import { CodeBlockView } from './CodeBlockView';
import { DateWikilink } from './DateWikilink';
import { EditorBubbleMenu } from './EditorBubbleMenu';
import { InlineTagDecoration } from './InlineTagDecoration';
import { SlashCommand } from './SlashCommand';

const lowlight = createLowlight(common);
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const CustomCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (!this.editor.isActive('codeBlock')) return false;
        this.editor.commands.insertContent('  ');
        return true;
      },
      'Mod-Enter': () => {
        if (!this.editor.isActive('codeBlock')) return false;
        return this.editor.commands.exitCode();
      },
    };
  },
}).configure({ lowlight });

const CustomTaskList = TaskList.extend({
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-9': () => this.editor.commands.toggleTaskList(),
    };
  },
});

interface NoteEditorProps {
  noteDate: string;
  contentMd: string;
  syncVersion: number;
  sourceMode: boolean;
  knownDates: Set<string>;
  recentNoteDates: string[];
  onChangeMarkdown: (nextMd: string) => void;
  onNavigateDate: (date: string) => void;
  onClickTag: (tag: string) => void;
  onSendSelectionToChat: (selectedText: string) => void;
  onOpenLightbox: (src: string, alt: string) => void;
  onNotify: (message: string) => void;
}

export function NoteEditor({
  noteDate,
  contentMd,
  syncVersion,
  sourceMode,
  knownDates,
  recentNoteDates,
  onChangeMarkdown,
  onNavigateDate,
  onClickTag,
  onSendSelectionToChat,
  onOpenLightbox,
  onNotify,
}: NoteEditorProps) {
  const [uploading, setUploading] = useState(false);
  const [inTable, setInTable] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const suppressNextUpdateRef = useRef(false);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const contentMdRef = useRef(contentMd);
  const noteDateRef = useRef(noteDate);
  const knownDatesRef = useRef(knownDates);
  const recentDatesRef = useRef(recentNoteDates);
  const onChangeRef = useRef(onChangeMarkdown);
  const onNavigateRef = useRef(onNavigateDate);
  const onClickTagRef = useRef(onClickTag);
  const onOpenLightboxRef = useRef(onOpenLightbox);
  const onNotifyRef = useRef(onNotify);

  contentMdRef.current = contentMd;
  noteDateRef.current = noteDate;
  knownDatesRef.current = knownDates;
  recentDatesRef.current = recentNoteDates;
  onChangeRef.current = onChangeMarkdown;
  onNavigateRef.current = onNavigateDate;
  onClickTagRef.current = onClickTag;
  onOpenLightboxRef.current = onOpenLightbox;
  onNotifyRef.current = onNotify;

  const initialDoc = useMemo(() => markdownToDoc(contentMd), []);

  const handleImageUpload = useCallback(
    async (file: File, insertAtPos?: number, editorInstance?: ReturnType<typeof useEditor>) => {
      if (!ALLOWED_IMAGE_MIME.has(file.type)) {
        onNotifyRef.current('仅支持上传 PNG、JPEG、WebP 或 GIF 图片');
        return;
      }
      setUploading(true);
      try {
        const res = await uploadAttachment(file, noteDateRef.current);
        const ed = editorInstance;
        if (ed) {
          const chain = ed.chain().focus();
          if (typeof insertAtPos === 'number') {
            chain.setTextSelection(insertAtPos);
          }
          chain
            .setImage({
              src: res.render_url,
              alt: res.orig_name,
            })
            .run();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '图片上传失败';
        onNotifyRef.current(msg);
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: '开始记录今天的工作、想法与待办… 输入 / 插入块，[[ 引用日期',
      }),
      Highlight,
      Link.configure({
        openOnClick: false,
        autolink: true,
        validate: (url) => isSafeUrl(url),
        HTMLAttributes: {
          rel: 'noopener noreferrer nofollow',
        },
      }),
      CustomTaskList,
      TaskItem.configure({
        nested: true,
      }),
      Table.extend({
        addNodeView() {
          return ({ node }) => new TableView(node, this.options.cellMinWidth);
        },
      }),
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({
        inline: false,
        allowBase64: false,
      }),
      CustomCodeBlock,
      DateWikilink.configure({
        onNavigateDate: (d) => onNavigateRef.current(d),
        getKnownDates: () => knownDatesRef.current,
        getRecentNoteDates: () => recentDatesRef.current,
      }),
      InlineTagDecoration.configure({
        onClickTag: (tag) => onClickTagRef.current(tag),
      }),
      SlashCommand.configure({
        onTriggerImagePick: () => {
          fileInputRef.current?.click();
        },
      }),
    ],
    content: initialDoc,
    onUpdate: ({ editor: ed }) => {
      if (suppressNextUpdateRef.current) {
        suppressNextUpdateRef.current = false;
        return;
      }
      const nextMd = docToMarkdown(ed.getJSON() as TiptapNode);
      onChangeRef.current(nextMd);
    },
    onSelectionUpdate: ({ editor: ed }) => {
      setInTable(ed.isActive('table'));
    },
    editorProps: {
      handleClick: (_view, _pos, event) => {
        const target = event.target as HTMLElement | null;
        if (target?.tagName === 'IMG') {
          const img = target as HTMLImageElement;
          onOpenLightboxRef.current(img.src, img.alt || '');
          return true;
        }
        const anchor = target?.closest?.('a') as HTMLAnchorElement | null;
        if (anchor && (event.metaKey || event.ctrlKey)) {
          const href = anchor.getAttribute('href') || '';
          if (isSafeUrl(href)) {
            window.open(href, '_blank', 'noopener,noreferrer');
            return true;
          }
        }
        return false;
      },
      handlePaste: (view, event) => {
        const items = event.clipboardData?.files;
        if (items && items.length > 0) {
          const imageFile = Array.from(items).find((f) => f.type.startsWith('image/'));
          if (imageFile) {
            event.preventDefault();
            void handleImageUpload(imageFile, view.state.selection.from, editorRef.current);
            return true;
          }
        }
        // If text pasted is a safe URL while text is selected, apply as link
        if (!view.state.selection.empty) {
          const pastedText = event.clipboardData?.getData('text/plain')?.trim() || '';
          const ed = editorRef.current;
          if (/^https?:\/\/\S+$/i.test(pastedText) && isSafeUrl(pastedText) && ed) {
            event.preventDefault();
            ed.chain().focus().setLink({ href: pastedText }).run();
            return true;
          }
        }
        return false;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        const imageFile = Array.from(files).find((f) => f.type.startsWith('image/'));
        if (!imageFile) return false;

        event.preventDefault();
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        void handleImageUpload(imageFile, coords?.pos, editorRef.current);
        return true;
      },
    },
  });

  editorRef.current = editor;

  // Sync external server updates / date switches / mode switches into Tiptap without firing dirty onChange
  const prevSourceModeRef = useRef(sourceMode);
  useEffect(() => {
    if (!editor) return;
    const switchedBackToWysiwyg = prevSourceModeRef.current && !sourceMode;
    prevSourceModeRef.current = sourceMode;

    if (!sourceMode) {
      const targetMd = contentMdRef.current;
      const currentEditorMd = docToMarkdown(editor.getJSON() as TiptapNode);
      if (switchedBackToWysiwyg || currentEditorMd !== targetMd) {
        suppressNextUpdateRef.current = true;
        editor.commands.setContent(markdownToDoc(targetMd), false);
        suppressNextUpdateRef.current = false;
      }
    }
  }, [editor, syncVersion, sourceMode]);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file && editor) {
      void handleImageUpload(file, undefined, editor);
    }
  };

  return (
    <div className="dn-editor-shell">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />

      {uploading && <div className="dn-upload-pill">⏳ 正在保存图片到本地…</div>}

      {!sourceMode && editor && inTable && (
        <div className="dn-table-toolbar" role="toolbar" aria-label="表格操作">
          <button
            type="button"
            className="dn-btn-sm"
            onClick={() => editor.chain().focus().addRowAfter().run()}
          >
            +行
          </button>
          <button
            type="button"
            className="dn-btn-sm"
            onClick={() => editor.chain().focus().addColumnAfter().run()}
          >
            +列
          </button>
          <button
            type="button"
            className="dn-btn-sm"
            onClick={() => editor.chain().focus().deleteRow().run()}
          >
            删行
          </button>
          <button
            type="button"
            className="dn-btn-sm"
            onClick={() => editor.chain().focus().deleteColumn().run()}
          >
            删列
          </button>
          <button
            type="button"
            className="dn-btn-sm"
            onClick={() => editor.chain().focus().deleteTable().run()}
          >
            删表
          </button>
        </div>
      )}

      {!sourceMode ? (
        <div className="dn-editor-wysiwyg" data-testid="dn-editor-wysiwyg">
          {editor && (
            <EditorBubbleMenu
              editor={editor}
              onSendSelectionToChat={onSendSelectionToChat}
            />
          )}
          <EditorContent editor={editor} />
        </div>
      ) : (
        <textarea
          className="dn-editor-source"
          data-testid="dn-editor-source"
          aria-label="Markdown 源码编辑器"
          value={contentMd}
          onChange={(e) => onChangeMarkdown(e.target.value)}
          placeholder="在此编辑纯 Markdown 源码…"
          spellCheck={false}
        />
      )}
    </div>
  );
}
