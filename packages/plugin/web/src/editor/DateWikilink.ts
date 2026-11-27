import { InputRule, Node, mergeAttributes } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { getTodayDateString, isValidDateStr, shiftDate } from '../lib/date';
import {
  SuggestionPopup,
  type SuggestionOption,
  type SuggestionPopupRef,
  positionPopupNearRect,
} from './SuggestionPopup';

export interface DateWikilinkOptions {
  onNavigateDate: (date: string) => void;
  getKnownDates: () => Set<string>;
  getRecentNoteDates: () => string[];
}

interface DateSuggestionItem extends SuggestionOption {
  date: string;
}

const WIKILINK_INPUT_RE = /\[\[(\d{4}-\d{2}-\d{2})\]\]$/;
const DATE_SUGGESTION_KEY = new PluginKey('dnDateWikilinkSuggestion');

function findWikilinkSuggestionMatch(config: { $position: { pos: number; nodeBefore: { isText?: boolean; text?: string } | null } }) {
  const nodeBefore = config.$position.nodeBefore;
  const text = nodeBefore?.isText ? nodeBefore.text : '';
  if (!text) return null;

  const textFrom = config.$position.pos - text.length;
  const openIdx = text.lastIndexOf('[[');
  if (openIdx < 0) return null;

  const tail = text.slice(openIdx + 2);
  // Stop matching if closed or contains whitespace/newlines
  if (tail.includes(']]') || /\s/.test(tail)) return null;

  const from = textFrom + openIdx;
  const to = config.$position.pos;
  return {
    range: { from, to },
    query: tail,
    text: text.slice(openIdx),
  };
}

export const DateWikilink = Node.create<DateWikilinkOptions>({
  name: 'dateWikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      onNavigateDate: () => {},
      getKnownDates: () => new Set<string>(),
      getRecentNoteDates: () => [],
    };
  },

  addAttributes() {
    return {
      date: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-date-wikilink') || '',
        renderHTML: (attributes) => ({
          'data-date-wikilink': String(attributes.date || ''),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-date-wikilink]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const date = String(node.attrs.date || '');
    const exists = this.options.getKnownDates().has(date);
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: exists ? 'dn-wikilink' : 'dn-wikilink missing',
        title: `跳转到 ${date}`,
      }),
      `📅 ${date}`,
    ];
  },

  addNodeView() {
    const getKnownDates = () => this.options.getKnownDates();
    const onNavigateDate = (d: string) => this.options.onNavigateDate(d);

    return ({ node }) => {
      const dom = document.createElement('span');
      let currentDate = String(node.attrs.date || '');
      const syncClass = (d: string) => {
        const exists = getKnownDates().has(d);
        dom.className = exists ? 'dn-wikilink' : 'dn-wikilink missing';
      };
      syncClass(currentDate);
      dom.setAttribute('data-date-wikilink', currentDate);
      dom.setAttribute('role', 'link');
      dom.setAttribute('tabindex', '0');
      dom.title = `跳转到 ${currentDate}`;
      dom.textContent = `📅 ${currentDate}`;

      const activate = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isValidDateStr(currentDate)) onNavigateDate(currentDate);
      };

      // Keep the editor from moving its selection and scrolling before the click lands.
      dom.addEventListener('mousedown', (event) => {
        if (event.button === 0) event.preventDefault();
      });
      dom.addEventListener('click', activate);
      dom.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') activate(event);
      });

      return {
        dom,
        stopEvent: (event) => event.type === 'mousedown' || event.type === 'click',
        update(updatedNode) {
          if (updatedNode.type.name !== 'dateWikilink') return false;
          currentDate = String(updatedNode.attrs.date || '');
          dom.setAttribute('data-date-wikilink', currentDate);
          dom.title = `跳转到 ${currentDate}`;
          dom.textContent = `📅 ${currentDate}`;
          syncClass(currentDate);
          return true;
        },
      };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: WIKILINK_INPUT_RE,
        handler: ({ state, range, match }) => {
          const dateStr = match[1];
          if (!isValidDateStr(dateStr)) return;
          const node = this.type.create({ date: dateStr });
          state.tr.replaceWith(range.from, range.to, node);
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const getKnownDates = () => this.options.getKnownDates();
    const getRecentNoteDates = () => this.options.getRecentNoteDates();

    return [
      Suggestion<DateSuggestionItem>({
        pluginKey: DATE_SUGGESTION_KEY,
        editor: this.editor,
        char: '[[',
        allowedPrefixes: null,
        findSuggestionMatch: (config) => findWikilinkSuggestionMatch(config),
        allow: ({ editor }) => !editor.isActive('codeBlock'),
        items: ({ query }) => {
          const today = getTodayDateString();
          const yesterday = shiftDate(today, -1);
          const tomorrow = shiftDate(today, 1);
          const known = getKnownDates();
          const recent = getRecentNoteDates();

          const candidateDates = new Map<string, string>();
          candidateDates.set(today, '今天');
          candidateDates.set(yesterday, '昨天');
          candidateDates.set(tomorrow, '明天');
          for (const d of recent) {
            if (!candidateDates.has(d)) candidateDates.set(d, '已有笔记');
          }

          const q = query.trim().toLowerCase();
          const items: DateSuggestionItem[] = [];
          for (const [date, tagLabel] of candidateDates.entries()) {
            const existsMark = known.has(date) ? '●' : '○';
            if (!q || date.includes(q) || tagLabel.toLowerCase().includes(q)) {
              items.push({
                id: date,
                date,
                icon: existsMark,
                label: date,
                hint: tagLabel,
              });
            }
          }

          if (isValidDateStr(q) && !candidateDates.has(q)) {
            items.unshift({
              id: q,
              date: q,
              icon: known.has(q) ? '●' : '○',
              label: q,
              hint: '指定日期',
            });
          }

          return items.slice(0, 12);
        },
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              { type: 'dateWikilink', attrs: { date: props.date } },
              { type: 'text', text: ' ' },
            ])
            .run();
        },
        render: () => {
          let component: ReactRenderer<SuggestionPopupRef> | null = null;
          let wrapper: HTMLElement | null = null;

          return {
            onStart(props: SuggestionProps<DateSuggestionItem>) {
              wrapper = document.createElement('div');
              document.body.appendChild(wrapper);

              component = new ReactRenderer(SuggestionPopup, {
                props: {
                  items: props.items,
                  command: props.command,
                  testId: 'dn-wikilink-menu',
                  emptyText: '输入 YYYY-MM-DD',
                },
                editor: props.editor,
              });

              wrapper.appendChild(component.element);
              positionPopupNearRect(wrapper, props.clientRect?.());
            },
            onUpdate(props: SuggestionProps<DateSuggestionItem>) {
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
