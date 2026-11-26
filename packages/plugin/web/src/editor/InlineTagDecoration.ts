import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface InlineTagDecorationOptions {
  onClickTag: (tag: string) => void;
}

const INLINE_TAG_RE = /(?:^|[\s(（【\[])(#([\p{L}\p{N}_][\p{L}\p{N}_/-]{0,48}))/gu;
const URL_SPAN_RE = /https?:\/\/[^\s)]+/gi;
const INLINE_TAG_PLUGIN_KEY = new PluginKey('dnInlineTagDecoration');

function buildTagDecorations(doc: Parameters<typeof DecorationSet.create>[0]): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') {
      return false; // never decorate inside fenced code blocks
    }
    if (!node.isText || !node.text) {
      return true;
    }

    // Ignore text carrying code or link marks
    if (node.marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) {
      return true;
    }

    const text = node.text;
    const urlRanges: Array<[number, number]> = [];
    for (const um of text.matchAll(URL_SPAN_RE)) {
      const start = um.index ?? 0;
      urlRanges.push([start, start + um[0].length]);
    }

    for (const match of text.matchAll(INLINE_TAG_RE)) {
      const fullMatch = match[0];
      const hashAndTag = match[1];
      const rawTag = match[2];
      const matchStart = match.index ?? 0;
      const hashOffset = fullMatch.length - hashAndTag.length;
      const tagStart = matchStart + hashOffset;
      const cleanTag = rawTag.replace(/[-/]+$/, '').toLowerCase();
      if (!cleanTag) continue;

      const tagEnd = tagStart + 1 + cleanTag.length;
      const insideUrl = urlRanges.some(([uStart, uEnd]) => tagStart >= uStart && tagStart < uEnd);
      if (insideUrl) continue;

      decorations.push(
        Decoration.inline(pos + tagStart, pos + tagEnd, {
          class: 'dn-inline-tag',
          'data-inline-tag': cleanTag,
          title: `按 #${cleanTag} 搜索笔记`,
        }),
      );
    }

    return true;
  });

  return DecorationSet.create(doc, decorations);
}

export const InlineTagDecoration = Extension.create<InlineTagDecorationOptions>({
  name: 'inlineTagDecoration',

  addOptions() {
    return {
      onClickTag: () => {},
    };
  },

  addProseMirrorPlugins() {
    const getHandler = () => this.options.onClickTag;

    return [
      new Plugin({
        key: INLINE_TAG_PLUGIN_KEY,
        state: {
          init: (_, { doc }) => buildTagDecorations(doc),
          apply: (tr, oldSet) => (tr.docChanged ? buildTagDecorations(tr.doc) : oldSet),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleClick(_view, _pos, event) {
            const target = event.target as HTMLElement | null;
            const tagEl = target?.closest?.('[data-inline-tag]') as HTMLElement | null;
            if (!tagEl) return false;
            const tag = tagEl.getAttribute('data-inline-tag');
            if (!tag) return false;
            event.preventDefault();
            getHandler()(tag);
            return true;
          },
        },
      }),
    ];
  },
});
