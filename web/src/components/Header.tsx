import { useEffect, useRef, useState } from 'react';
import { formatHeaderDate } from '../lib/date';

interface HeaderProps {
  currentDate: string;
  todayDate: string;
  canGoBack: boolean;
  calendarOpen: boolean;
  searchOpen: boolean;
  sourceMode: boolean;
  onGoBack: () => void;
  onPrevDay: () => void;
  onNextDay: () => void;
  onJumpToday: () => void;
  onToggleCalendar: () => void;
  onToggleSearch: () => void;
  onAiSummary: () => void;
  onToggleSource: () => void;
  onCopyMarkdown: () => void;
  onCopyResourceUri: () => void;
  onExportMd: (frontmatter: boolean) => void;
  onOpenRevisions: () => void;
}

export function Header({
  currentDate,
  todayDate,
  canGoBack,
  calendarOpen,
  searchOpen,
  sourceMode,
  onGoBack,
  onPrevDay,
  onNextDay,
  onJumpToday,
  onToggleCalendar,
  onToggleSearch,
  onAiSummary,
  onToggleSource,
  onCopyMarkdown,
  onCopyResourceUri,
  onExportMd,
  onOpenRevisions,
}: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [compact, setCompact] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 400 : true,
  );
  const menuWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < 400);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuWrapRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const isToday = currentDate === todayDate;

  return (
    <header className="dn-header" data-testid="dn-header">
      <div className="dn-header-left">
        {canGoBack && (
          <button
            type="button"
            className="dn-icon-btn"
            data-testid="dn-back-btn"
            onClick={onGoBack}
            title="返回上一浏览日期 (Alt+←)"
            aria-label="返回上一浏览日期"
          >
            ←
          </button>
        )}

        <button
          type="button"
          className="dn-icon-btn"
          data-testid="dn-prev-day"
          onClick={onPrevDay}
          title="前一天"
          aria-label="前一天"
        >
          ‹
        </button>

        <button
          type="button"
          className="dn-date-title"
          data-testid="dn-date-title"
          onClick={onToggleCalendar}
          aria-expanded={calendarOpen}
          title="展开/收起迷你日历"
        >
          <span>{formatHeaderDate(currentDate, todayDate, compact)}</span>
          <span aria-hidden="true">▾</span>
        </button>

        {!isToday && (
          <button
            type="button"
            className="dn-today-pill"
            data-testid="dn-today-btn"
            onClick={onJumpToday}
            title="回到今天"
          >
            今天
          </button>
        )}

        <button
          type="button"
          className="dn-icon-btn"
          data-testid="dn-next-day"
          onClick={onNextDay}
          title="后一天"
          aria-label="后一天"
        >
          ›
        </button>
      </div>

      <div className="dn-header-right" ref={menuWrapRef}>
        <button
          type="button"
          className={`dn-icon-btn${searchOpen ? ' active' : ''}`}
          data-testid="dn-search-btn"
          onClick={onToggleSearch}
          title="全文与标签搜索 (⌘K)"
          aria-label="搜索笔记"
          aria-expanded={searchOpen}
        >
          🔍
        </button>

        <button
          type="button"
          className="dn-icon-btn"
          data-testid="dn-ai-summary-btn"
          onClick={onAiSummary}
          title="AI 总结今日笔记"
          aria-label="AI 总结今日笔记"
        >
          ✨
        </button>

        <button
          type="button"
          className={`dn-icon-btn${sourceMode ? ' active' : ''}`}
          data-testid="dn-source-toggle"
          onClick={onToggleSource}
          title="切换所见即所得 / Markdown 源码模式 (⌘/)"
          aria-label="切换源码模式"
          aria-pressed={sourceMode}
        >
          <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--dn-mono)' }}>
            {'</>'}
          </span>
        </button>

        <button
          type="button"
          className="dn-icon-btn"
          data-testid="dn-more-btn"
          onClick={() => setMenuOpen((v) => !v)}
          title="更多操作"
          aria-label="更多操作"
          aria-expanded={menuOpen}
        >
          ···
        </button>

        {menuOpen && (
          <div className="dn-menu-popover" role="menu">
            <button
              type="button"
              role="menuitem"
              className="dn-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onCopyMarkdown();
              }}
            >
              <span>📋 复制今日 Markdown</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dn-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onCopyResourceUri();
              }}
            >
              <span>📎 复制引用 URI (daily-notes://notes/{currentDate})</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dn-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onExportMd(false);
              }}
            >
              <span>⬇ 导出 {currentDate}.md</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dn-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onExportMd(true);
              }}
            >
              <span>🏷 导出含 Frontmatter .md</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="dn-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onOpenRevisions();
              }}
            >
              <span>🕒 查看历史快照</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
