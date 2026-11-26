import { useEffect, useMemo, useState } from 'react';
import { fetchCalendar } from '../lib/api';
import { buildMonthGrid, formatMonthHeading, shiftMonth } from '../lib/date';
import type { CalendarDay, ProjectSummary, TagCount } from '../types';

interface CalendarDrawerProps {
  open: boolean;
  currentDate: string;
  todayDate: string;
  tags: TagCount[];
  projects: ProjectSummary[];
  onSelectDate: (date: string) => void;
  onClose: () => void;
}

const WEEKDAY_HEADERS = ['一', '二', '三', '四', '五', '六', '日'];

export function CalendarDrawer({
  open,
  currentDate,
  todayDate,
  tags,
  projects,
  onSelectDate,
  onClose,
}: CalendarDrawerProps) {
  const [month, setMonth] = useState(() => currentDate.slice(0, 7));
  const [filterTag, setFilterTag] = useState('');
  const [filterWs, setFilterWs] = useState('');
  const [daysMap, setDaysMap] = useState<Map<string, CalendarDay>>(() => new Map());

  useEffect(() => {
    if (open) {
      setMonth(currentDate.slice(0, 7));
    }
  }, [open, currentDate]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchCalendar({ month, tag: filterTag, workspace_uri: filterWs })
      .then((res) => {
        if (cancelled) return;
        const map = new Map<string, CalendarDay>();
        for (const d of res.days) {
          map.set(d.date, d);
        }
        setDaysMap(map);
      })
      .catch(() => {
        // ignore transient calendar fetch error
      });
    return () => {
      cancelled = true;
    };
  }, [open, month, filterTag, filterWs]);

  const cells = useMemo(() => buildMonthGrid(month), [month]);

  if (!open) return null;

  return (
    <section
      className="dn-calendar-drawer"
      data-testid="dn-calendar-drawer"
      aria-label="迷你日历"
    >
      <div className="dn-cal-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="dn-icon-btn"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            aria-label="上个月"
          >
            ‹
          </button>
          <span className="dn-cal-title">{formatMonthHeading(month)}</span>
          <button
            type="button"
            className="dn-icon-btn"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            aria-label="下个月"
          >
            ›
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {month !== todayDate.slice(0, 7) && (
            <button
              type="button"
              className="dn-btn-sm"
              onClick={() => setMonth(todayDate.slice(0, 7))}
            >
              回到本月
            </button>
          )}
          <button type="button" className="dn-btn-sm ghost" onClick={onClose}>
            收起
          </button>
        </div>
      </div>

      <div className="dn-cal-weekdays">
        {WEEKDAY_HEADERS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>

      <div className="dn-cal-grid">
        {cells.map((cell) => {
          const info = daysMap.get(cell.date);
          const hasNote = Boolean(info?.has_note);
          const hasOpenTodos = Boolean(info && info.todo_total > info.todo_done);
          const isToday = cell.date === todayDate;
          const isSelected = cell.date === currentDate;

          const classNames = ['dn-cal-cell'];
          if (!cell.inCurrentMonth) classNames.push('outside');
          if (isToday) classNames.push('today');
          if (isSelected) classNames.push('selected');

          return (
            <button
              key={cell.date}
              type="button"
              className={classNames.join(' ')}
              onClick={() => {
                onSelectDate(cell.date);
                onClose();
              }}
              aria-label={cell.date}
              title={
                hasNote && info
                  ? `${cell.date} · ${info.todo_done}/${info.todo_total} 待办`
                  : cell.date
              }
            >
              <span>{cell.dayNumber}</span>
              {hasNote && (
                <span
                  className={`dn-cal-dot${hasOpenTodos ? ' open-todos' : ''}`}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>

      {(tags.length > 0 || projects.length > 0) && (
        <div className="dn-cal-filters">
          {tags.slice(0, 8).map((t) => (
            <button
              key={t.tag}
              type="button"
              className={`dn-pill-filter${filterTag === t.tag ? ' active' : ''}`}
              onClick={() => setFilterTag((prev) => (prev === t.tag ? '' : t.tag))}
            >
              #{t.tag}
            </button>
          ))}
          {projects.slice(0, 4).map((p) => (
            <button
              key={p.workspace_uri}
              type="button"
              className={`dn-pill-filter${filterWs === p.workspace_uri ? ' active' : ''}`}
              onClick={() =>
                setFilterWs((prev) => (prev === p.workspace_uri ? '' : p.workspace_uri))
              }
            >
              📁 {p.workspace_name}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
