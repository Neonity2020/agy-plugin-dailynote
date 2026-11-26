import { useEffect, useState } from 'react';
import { searchNotes, type WorkspaceInfo } from '../lib/api';
import { shiftDate } from '../lib/date';
import type { ProjectSummary, SearchResultItem, TagCount } from '../types';

interface SearchDrawerProps {
  open: boolean;
  todayDate: string;
  initialTag?: string;
  tags: TagCount[];
  projects: ProjectSummary[];
  activeWorkspaces: WorkspaceInfo[];
  onSelectDate: (date: string) => void;
  onClose: () => void;
}

type DatePreset = 'all' | '7d' | '30d';

function renderSafeSnippet(htmlSnippet: string) {
  const parts = htmlSnippet.split(/(<mark>[\s\S]*?<\/mark>)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('<mark>') && part.endsWith('</mark>')) {
      const inner = part
        .slice(6, -7)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
      return <mark key={idx}>{inner}</mark>;
    }
    const decoded = part
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    return <span key={idx}>{decoded}</span>;
  });
}

export function SearchDrawer({
  open,
  todayDate,
  initialTag = '',
  tags,
  projects,
  activeWorkspaces,
  onSelectDate,
  onClose,
}: SearchDrawerProps) {
  const [query, setQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [selectedWs, setSelectedWs] = useState('');
  const [preset, setPreset] = useState<DatePreset>('all');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (open && initialTag) {
      setSelectedTag(initialTag.replace(/^#/, '').toLowerCase());
    }
  }, [open, initialTag]);

  useEffect(() => {
    if (!open) return;

    const timer = setTimeout(() => {
      let effectiveQuery = query.trim();
      let effectiveTag = selectedTag;

      // Support typing "#tag" directly in the search box
      const inlineTagOnly = /^#([\p{L}\p{N}_][\p{L}\p{N}_/-]{0,48})$/u.exec(effectiveQuery);
      if (inlineTagOnly && !effectiveTag) {
        effectiveTag = inlineTagOnly[1].toLowerCase();
        effectiveQuery = '';
      }

      const from =
        preset === '7d'
          ? shiftDate(todayDate, -6)
          : preset === '30d'
            ? shiftDate(todayDate, -29)
            : '';

      setLoading(true);
      searchNotes({
        q: effectiveQuery,
        tag: effectiveTag,
        workspace_uri: selectedWs,
        from,
        limit: 40,
      })
        .then((res) => {
          setResults(res.items);
          setTotal(res.total);
        })
        .catch(() => {
          setResults([]);
          setTotal(0);
        })
        .finally(() => setLoading(false));
    }, 200);

    return () => clearTimeout(timer);
  }, [open, query, selectedTag, selectedWs, preset, todayDate]);

  if (!open) return null;

  const projectOptions = new Map<string, string>();
  for (const ws of activeWorkspaces) {
    projectOptions.set(ws.uri, `${ws.name} (当前)`);
  }
  for (const p of projects) {
    if (!projectOptions.has(p.workspace_uri)) {
      projectOptions.set(p.workspace_uri, p.workspace_name);
    }
  }

  return (
    <section
      className="dn-drawer-overlay"
      data-testid="dn-search-drawer"
      aria-label="搜索每日笔记"
    >
      <div className="dn-drawer-head">
        <input
          type="search"
          className="dn-search-input"
          placeholder="搜索中英文关键词或 #标签…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button type="button" className="dn-btn-sm" onClick={onClose}>
          关闭
        </button>
      </div>

      <div className="dn-drawer-filters">
        <div className="dn-filter-row">
          <button
            type="button"
            className={`dn-pill-filter${preset === 'all' ? ' active' : ''}`}
            onClick={() => setPreset('all')}
          >
            全部时间
          </button>
          <button
            type="button"
            className={`dn-pill-filter${preset === '7d' ? ' active' : ''}`}
            onClick={() => setPreset('7d')}
          >
            近 7 天
          </button>
          <button
            type="button"
            className={`dn-pill-filter${preset === '30d' ? ' active' : ''}`}
            onClick={() => setPreset('30d')}
          >
            近 30 天
          </button>

          {projectOptions.size > 0 && (
            <select
              className="dn-select-sm"
              aria-label="按项目筛选"
              value={selectedWs}
              onChange={(e) => setSelectedWs(e.target.value)}
            >
              <option value="">全部项目</option>
              {[...projectOptions.entries()].map(([uri, name]) => (
                <option key={uri} value={uri}>
                  {name}
                </option>
              ))}
            </select>
          )}
        </div>

        {tags.length > 0 && (
          <div className="dn-filter-row">
            {tags.slice(0, 12).map((t) => (
              <button
                key={t.tag}
                type="button"
                className={`dn-pill-filter${selectedTag === t.tag ? ' active' : ''}`}
                onClick={() => setSelectedTag((prev) => (prev === t.tag ? '' : t.tag))}
              >
                #{t.tag} ({t.count})
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="dn-drawer-body">
        {loading && <div className="dn-empty-muted">检索中…</div>}

        {!loading && results.length === 0 && (
          <div className="dn-empty-muted">未找到匹配的每日笔记</div>
        )}

        {!loading && results.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: 'var(--dn-fg-muted)', marginBottom: 8 }}>
              共命中 {total} 篇笔记
            </div>
            {results.map((item) => (
              <button
                key={item.date}
                type="button"
                className="dn-result-card"
                onClick={() => {
                  onSelectDate(item.date);
                  onClose();
                }}
              >
                <div className="dn-result-meta">
                  <span className="dn-result-date">{item.date}</span>
                  <span>
                    {item.todo_total > 0 ? `${item.todo_done}/${item.todo_total} 待办` : ''}
                  </span>
                </div>
                {item.title && (
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--dn-fg)' }}>
                    {item.title}
                  </div>
                )}
                {item.snippet && (
                  <div className="dn-result-snippet">{renderSafeSnippet(item.snippet)}</div>
                )}
                {(item.tags.length > 0 || item.projects.length > 0) && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                    {item.projects.map((p) => (
                      <span key={p.workspace_uri} className="dn-project-chip">
                        📁 {p.workspace_name}
                      </span>
                    ))}
                    {item.tags.slice(0, 5).map((tag) => (
                      <span
                        key={tag}
                        style={{ fontSize: 11, color: 'var(--dn-primary)' }}
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
