import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

export interface SuggestionOption {
  id: string;
  label: string;
  icon?: string;
  hint?: string;
}

export interface SuggestionPopupRef {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface SuggestionPopupProps<T extends SuggestionOption> {
  items: T[];
  command: (item: T) => void;
  testId?: string;
  emptyText?: string;
}

function SuggestionPopupInner<T extends SuggestionOption>(
  { items, command, testId = 'dn-suggestion-menu', emptyText = '无匹配项' }: SuggestionPopupProps<T>,
  ref: React.Ref<SuggestionPopupRef>,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  const selectItem = (index: number) => {
    const item = items[index];
    if (item) command(item);
  };

  useImperativeHandle(ref, () => ({
    onKeyDown(event: KeyboardEvent) {
      if (items.length === 0) {
        return event.key === 'Escape';
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((prev) => (prev + items.length - 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        selectItem(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div className="dn-suggestion-menu" data-testid={testId}>
        <div className="dn-empty-muted" style={{ padding: '8px 10px' }}>
          {emptyText}
        </div>
      </div>
    );
  }

  return (
    <div className="dn-suggestion-menu" data-testid={testId} role="listbox">
      {items.map((item, idx) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={idx === selectedIndex}
          className={`dn-suggestion-item${idx === selectedIndex ? ' selected' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            selectItem(idx);
          }}
        >
          <span className="dn-suggestion-left">
            {item.icon && <span className="dn-suggestion-icon">{item.icon}</span>}
            <span>{item.label}</span>
          </span>
          {item.hint && <span className="dn-suggestion-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export const SuggestionPopup = forwardRef(SuggestionPopupInner) as <T extends SuggestionOption>(
  props: SuggestionPopupProps<T> & { ref?: React.Ref<SuggestionPopupRef> },
) => React.ReactElement;

/**
 * Position a floating popup cleanly within narrow 320px+ viewport bounds (8px margin).
 */
export function positionPopupNearRect(el: HTMLElement, rect: DOMRect | null | undefined) {
  if (!rect) return;
  const pad = 8;
  el.style.position = 'fixed';
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const menuWidth = Math.min(280, vw - pad * 2);
  const left = Math.max(pad, Math.min(rect.left, vw - menuWidth - pad));
  const estHeight = Math.min(260, el.offsetHeight || 220);
  const fitsBelow = rect.bottom + 4 + estHeight <= vh - pad;
  const top = fitsBelow
    ? rect.bottom + 4
    : Math.max(pad, rect.top - estHeight - 4);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
