import { useState } from 'react';
import { BubbleMenu, type Editor } from '@tiptap/react';
import { isSafeUrl } from '../lib/markdownCodec';

interface EditorBubbleMenuProps {
  editor: Editor;
  onSendSelectionToChat: (selectedText: string) => void;
}

export function EditorBubbleMenu({ editor, onSendSelectionToChat }: EditorBubbleMenuProps) {
  const [linkEditing, setLinkEditing] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  const openLinkEditor = () => {
    const existingHref = String(editor.getAttributes('link').href || '');
    setLinkUrl(existingHref);
    setLinkEditing(true);
  };

  const applyLink = () => {
    const trimmed = linkUrl.trim();
    if (!trimmed) {
      editor.chain().focus().unsetLink().run();
      setLinkEditing(false);
      return;
    }
    const candidate = /^https?:\/\/|^mailto:|^\/|^#|^sidecar:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    if (!isSafeUrl(candidate)) {
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: candidate }).run();
    setLinkEditing(false);
  };

  const handleSendToChat = () => {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, '\n').trim();
    if (text) {
      onSendSelectionToChat(text);
    }
  };

  return (
    <BubbleMenu
      editor={editor}
      updateDelay={100}
      shouldShow={({ editor: ed, state }) => {
        if (state.selection.empty) return false;
        if (ed.isActive('codeBlock') || ed.isActive('image')) return false;
        return true;
      }}
      tippyOptions={{
        duration: 100,
        placement: 'top',
        maxWidth: 'calc(100vw - 16px)',
        onHidden: () => setLinkEditing(false),
        popperOptions: {
          modifiers: [
            {
              name: 'preventOverflow',
              options: { padding: 8, boundary: 'viewport' },
            },
            {
              name: 'flip',
              options: { padding: 8 },
            },
          ],
        },
      }}
    >
      <div className="dn-bubble-menu" data-testid="dn-bubble-menu">
        <button
          type="button"
          className={`dn-bubble-btn${editor.isActive('bold') ? ' active' : ''}`}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="加粗 (⌘B)"
          aria-label="加粗"
        >
          B
        </button>
        <button
          type="button"
          className={`dn-bubble-btn${editor.isActive('italic') ? ' active' : ''}`}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="斜体 (⌘I)"
          aria-label="斜体"
        >
          <em>I</em>
        </button>
        <button
          type="button"
          className={`dn-bubble-btn${editor.isActive('strike') ? ' active' : ''}`}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title="删除线 (⌘⇧X)"
          aria-label="删除线"
        >
          <s>S</s>
        </button>
        <button
          type="button"
          className={`dn-bubble-btn${editor.isActive('code') ? ' active' : ''}`}
          onClick={() => editor.chain().focus().toggleCode().run()}
          title="行内代码 (⌘E)"
          aria-label="行内代码"
        >
          {'<>'}
        </button>
        <button
          type="button"
          className={`dn-bubble-btn${editor.isActive('highlight') ? ' active' : ''}`}
          onClick={() => editor.chain().focus().toggleHighlight().run()}
          title="高亮"
          aria-label="高亮"
        >
          H
        </button>
        <button
          type="button"
          className={`dn-bubble-btn${editor.isActive('link') ? ' active' : ''}`}
          onClick={openLinkEditor}
          title="超链接"
          aria-label="超链接"
        >
          🔗
        </button>

        <span className="dn-bubble-sep" aria-hidden="true" />

        <button
          type="button"
          className="dn-bubble-ask"
          onClick={handleSendToChat}
          title="将选中段落发送至当前对话"
        >
          💬 发送到对话
        </button>

        {linkEditing && (
          <div className="dn-bubble-link-row">
            <input
              type="url"
              className="dn-bubble-link-input"
              placeholder="https://..."
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyLink();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setLinkEditing(false);
                }
              }}
              autoFocus
            />
            <button type="button" className="dn-btn-sm primary" onClick={applyLink}>
              确定
            </button>
            {editor.isActive('link') && (
              <button
                type="button"
                className="dn-btn-sm"
                onClick={() => {
                  editor.chain().focus().unsetLink().run();
                  setLinkEditing(false);
                }}
              >
                移除
              </button>
            )}
          </div>
        )}
      </div>
    </BubbleMenu>
  );
}
