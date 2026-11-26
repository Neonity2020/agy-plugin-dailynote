import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import {
  SuggestionPopup,
  type SuggestionOption,
  type SuggestionPopupRef,
  positionPopupNearRect,
} from './SuggestionPopup';

export interface SlashCommandOptions {
  onTriggerImagePick: () => void;
}

interface SlashItem extends SuggestionOption {
  keywords: string;
  run: (ctx: { editor: Editor; range: Range }) => void;
}

const SLASH_PLUGIN_KEY = new PluginKey('dnSlashCommand');

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return {
      onTriggerImagePick: () => {},
    };
  },

  addProseMirrorPlugins() {
    const triggerImagePick = () => this.options.onTriggerImagePick();

    const allItems: SlashItem[] = [
      {
        id: 'taskList',
        icon: '☑',
        label: '任务清单',
        hint: '- [ ]',
        keywords: 'todo task list renwu daiban checkbox',
        run: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).toggleTaskList().run();
        },
      },
      {
        id: 'h1',
        icon: 'H1',
        label: '一级标题',
        hint: '#',
        keywords: 'h1 heading title biaoti',
        run: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run();
        },
      },
      {
        id: 'h2',
        icon: 'H2',
        label: '二级标题',
        hint: '##',
        keywords: 'h2 heading title biaoti',
        run: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run();
        },
      },
      {
        id: 'h3',
        icon: 'H3',
        label: '三级标题',
        hint: '###',
        keywords: 'h3 heading title biaoti',
        run: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run();
        },
      },
      {
        id: 'bulletList',
        icon: '•',
        label: '无序列表',
        hint: '-',
        keywords: 'bullet ul list wuxu liebiao',
        run: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).toggleBulletList().run();
        },
      },
      {
        id: 'orderedList',
        icon: '1.',
        label: '有序列表',
        hint: '1.',
        keywords: 'ordered ol list youxu liebiao',
        run: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).toggleOrderedList().run();
        },
      },
      {
        id: 'codeBlock',
        icon: '</>',
        label: '代码块',
        hint: '```',
        keywords: 'code block codeblock daima',
        run: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
        },
      },
      {
        id: 'blockquote',
        icon: '❝',
        label: '引用块',
        hint: '>',
        keywords: 'quote blockquote yinyong',
        run: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).toggleBlockquote().run();
        },
      },
      {
        id: 'table',
        icon: '⊞',
        label: '表格 (3×3)',
        hint: '| |',
        keywords: 'table grid biaoge',
        run: ({ editor, range }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run();
        },
      },
      {
        id: 'image',
        icon: '🖼',
        label: '插入图片',
        hint: 'img',
        keywords: 'image img photo tupian',
        run: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).run();
          triggerImagePick();
        },
      },
      {
        id: 'dateWikilink',
        icon: '📅',
        label: '日期双链',
        hint: '[[',
        keywords: 'date link wikilink riqi shuanglian',
        run: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).insertContent('[[').run();
        },
      },
      {
        id: 'horizontalRule',
        icon: '―',
        label: '分割线',
        hint: '---',
        keywords: 'hr divider line fengexian',
        run: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).setHorizontalRule().run();
        },
      },
    ];

    return [
      Suggestion<SlashItem>({
        pluginKey: SLASH_PLUGIN_KEY,
        editor: this.editor,
        char: '/',
        allowedPrefixes: [' '],
        allow: ({ editor }) => !editor.isActive('codeBlock'),
        items: ({ query }) => {
          const q = query.trim().toLowerCase();
          if (!q) return allItems;
          return allItems.filter(
            (item) =>
              item.label.toLowerCase().includes(q) ||
              item.keywords.includes(q) ||
              item.hint?.toLowerCase().includes(q),
          );
        },
        command: ({ editor, range, props }) => {
          props.run({ editor, range });
        },
        render: () => {
          let component: ReactRenderer<SuggestionPopupRef> | null = null;
          let wrapper: HTMLElement | null = null;

          return {
            onStart(props: SuggestionProps<SlashItem>) {
              wrapper = document.createElement('div');
              document.body.appendChild(wrapper);

              component = new ReactRenderer(SuggestionPopup, {
                props: {
                  items: props.items,
                  command: props.command,
                  testId: 'dn-slash-menu',
                  emptyText: '没有匹配的块类型',
                },
                editor: props.editor,
              });

              wrapper.appendChild(component.element);
              positionPopupNearRect(wrapper, props.clientRect?.());
            },
            onUpdate(props: SuggestionProps<SlashItem>) {
              component?.updateProps({
                items: props.items,
                command: props.command,
              });
              if (wrapper) {
                positionPopupNearRect(wrapper, props.clientRect?.());
              }
            },
            onKeyDown(props) {
              if (props.event.key === 'Escape') {
                wrapper?.remove();
                component?.destroy();
                wrapper = null;
                component = null;
                return true;
              }
              return component?.ref?.onKeyDown(props.event) ?? false;
            },
            onExit() {
              wrapper?.remove();
              component?.destroy();
              wrapper = null;
              component = null;
            },
          };
        },
      }),
    ];
  },
});
