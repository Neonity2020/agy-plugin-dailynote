import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banners } from './components/Banners';
import { CalendarDrawer } from './components/CalendarDrawer';
import { FooterBar, type SaveStatus } from './components/FooterBar';
import { Header } from './components/Header';
import { ImageLightbox } from './components/ImageLightbox';
import { ProjectBar } from './components/ProjectBar';
import { RevisionsDrawer } from './components/RevisionsDrawer';
import { SearchDrawer } from './components/SearchDrawer';
import { NoteEditor } from './editor/NoteEditor';
import {
  ApiError,
  addNoteProject,
  carryOverTodos,
  exportNoteMarkdown,
  fetchAllProjects,
  fetchCalendar,
  fetchNote,
  fetchNoteMeta,
  fetchRevisions,
  fetchTags,
  getActiveWorkspaces,
  removeNoteProject,
  restoreRevision,
  saveNote,
  sendMessageToAgent,
  type WorkspaceInfo,
} from './lib/api';
import { getTodayDateString, isValidDateStr, shiftDate } from './lib/date';
import { startThemeObserver } from './lib/theme';
import type {
  ConflictState,
  DailyNote,
  ProjectSummary,
  TagCount,
} from './types';

const AUTOSAVE_DEBOUNCE_MS = 500;
const POLL_INTERVAL_MS = 750;
const AGENT_UNDO_TTL_MS = 15000;

export function App() {
  const [todayDate, setTodayDate] = useState(() => getTodayDateString());
  const [currentDate, setCurrentDate] = useState(() => getTodayDateString());
  const [historyStack, setHistoryStack] = useState<string[]>([]);

  const [note, setNote] = useState<DailyNote | null>(null);
  const [contentMd, setContentMd] = useState('');
  const [syncVersion, setSyncVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  const [sourceMode, setSourceMode] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInitialTag, setSearchInitialTag] = useState('');
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [agentUndoAvailable, setAgentUndoAvailable] = useState(false);
  const [midnightTargetDate, setMidnightTargetDate] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [activeWorkspaces, setActiveWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [allTags, setAllTags] = useState<TagCount[]>([]);
  const [allProjects, setAllProjects] = useState<ProjectSummary[]>([]);
  const [knownDates, setKnownDates] = useState<Set<string>>(() => new Set());
  const [recentNoteDates, setRecentNoteDates] = useState<string[]>([]);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingPromiseRef = useRef<Promise<DailyNote | null> | null>(null);

  // Refs for reading fresh state inside async callbacks / listeners
  const currentDateRef = useRef(currentDate);
  const contentMdRef = useRef(contentMd);
  const dirtyRef = useRef(dirty);
  const noteRef = useRef(note);
  const conflictRef = useRef(conflict);

  currentDateRef.current = currentDate;
  contentMdRef.current = contentMd;
  dirtyRef.current = dirty;
  noteRef.current = note;
  conflictRef.current = conflict;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const refreshGlobalMetadata = useCallback(async (targetMonth: string) => {
    try {
      const [tagsRes, projRes, calRes] = await Promise.all([
        fetchTags(),
        fetchAllProjects(),
        fetchCalendar({ month: targetMonth }),
      ]);
      setAllTags(tagsRes.tags);
      setAllProjects(projRes.projects);

      const dates = calRes.days.filter((d) => d.has_note).map((d) => d.date).sort().reverse();
      setKnownDates((prev) => {
        const next = new Set(prev);
        for (const d of calRes.days) {
          if (d.has_note) next.add(d.date);
          else next.delete(d.date);
        }
        return next;
      });
      setRecentNoteDates(dates.slice(0, 10));
    } catch {
      // ignore metadata refresh failures
    }
  }, []);

  const applyServerNote = useCallback(
    (serverNote: DailyNote, { showAgentUndo = false } = {}) => {
      setNote(serverNote);
      setContentMd(serverNote.content_md);
      setSyncVersion((v) => v + 1);
      setDirty(false);
      setConflict(null);
      setSaveStatus(serverNote.exists && serverNote.content_md.trim() ? 'saved' : 'idle');

      setKnownDates((prev) => {
        const next = new Set(prev);
        if (serverNote.content_md.trim()) next.add(serverNote.date);
        else next.delete(serverNote.date);
        return next;
      });

      if (showAgentUndo) {
        setAgentUndoAvailable(true);
        if (agentUndoTimerRef.current) clearTimeout(agentUndoTimerRef.current);
        agentUndoTimerRef.current = setTimeout(() => setAgentUndoAvailable(false), AGENT_UNDO_TTL_MS);
      } else {
        setAgentUndoAvailable(false);
      }
    },
    [],
  );

  const loadDate = useCallback(
    async (date: string) => {
      try {
        const loaded = await fetchNote(date);
        if (currentDateRef.current !== date) return;
        applyServerNote(loaded, { showAgentUndo: false });
        void refreshGlobalMetadata(date.slice(0, 7));
      } catch (err) {
        showToast(err instanceof Error ? err.message : '加载笔记失败');
      }
    },
    [applyServerNote, refreshGlobalMetadata, showToast],
  );

  // Flush pending local edits immediately before navigation / toggle / blur / export
  const flushSave = useCallback(
    async (force = false): Promise<DailyNote | null> => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      if (savingPromiseRef.current) {
        await savingPromiseRef.current;
      }

      if (!dirtyRef.current && !force) {
        return noteRef.current;
      }
      if (conflictRef.current && !force) {
        return null;
      }

      const targetDate = currentDateRef.current;
      const mdToSave = contentMdRef.current;
      const expectedRev = noteRef.current?.revision ?? 0;

      const task = (async () => {
        setSaveStatus('saving');
        try {
          const saved = await saveNote({
            date: targetDate,
            content_md: mdToSave,
            expected_revision: expectedRev,
            force,
          });
          if (currentDateRef.current === targetDate) {
            setNote(saved);
            // Only clear dirty if user didn't keep typing during flight
            if (contentMdRef.current === mdToSave) {
              setDirty(false);
              setSaveStatus(saved.exists ? 'saved' : 'idle');
            }
            setConflict(null);
            void refreshGlobalMetadata(targetDate.slice(0, 7));
          }
          return saved;
        } catch (err) {
          if (err instanceof ApiError && err.code === 'REVISION_CONFLICT') {
            const serverNote = err.details?.server_note as DailyNote | undefined;
            if (serverNote && currentDateRef.current === targetDate) {
              setConflict({ serverNote, localMarkdown: contentMdRef.current });
              setSaveStatus('error');
            }
            return null;
          }
          setSaveStatus('error');
          showToast(err instanceof Error ? err.message : '自动保存失败');
          return null;
        } finally {
          savingPromiseRef.current = null;
        }
      })();

      savingPromiseRef.current = task;
      return task;
    },
    [refreshGlobalMetadata, showToast],
  );

  // Theme sync & initial workspace discovery
  useEffect(() => {
    const stopTheme = startThemeObserver();
    void getActiveWorkspaces().then(setActiveWorkspaces);
    return () => stopTheme();
  }, []);

  // Load note whenever currentDate changes
  useEffect(() => {
    void loadDate(currentDate);
  }, [currentDate, loadDate]);

  // Debounced autosave
  const handleMarkdownChange = useCallback(
    (nextMd: string) => {
      setContentMd(nextMd);
      setDirty(true);
      setSaveStatus('dirty');
      setAgentUndoAvailable(false);

      if (conflictRef.current) {
        return; // paused until user resolves conflict
      }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        void flushSave(false);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [flushSave],
  );

  // Navigate to another date, saving current changes first
  const navigateToDate = useCallback(
    async (targetDate: string, { pushHistory = false } = {}) => {
      if (!isValidDateStr(targetDate) || targetDate === currentDateRef.current) {
        return;
      }
      const saved = await flushSave(false);
      if (dirtyRef.current && saved?.content_md !== contentMdRef.current) return;
      if (pushHistory) {
        const prev = currentDateRef.current;
        setHistoryStack((stack) => (stack[stack.length - 1] === prev ? stack : [...stack, prev]));
      }
      setCurrentDate(targetDate);
    },
    [flushSave],
  );

  const handleGoBack = useCallback(async () => {
    if (historyStack.length === 0) return;
    const prevDate = historyStack[historyStack.length - 1];
    const saved = await flushSave(false);
    if (dirtyRef.current && saved?.content_md !== contentMdRef.current) return;
    setHistoryStack((stack) => stack.slice(0, -1));
    setCurrentDate(prevDate);
  }, [flushSave, historyStack]);

  // Poll /api/note/meta while visible, plus immediate check on window focus
  const checkExternalUpdates = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    const targetDate = currentDateRef.current;
    try {
      const meta = await fetchNoteMeta(targetDate);
      if (currentDateRef.current !== targetDate) return;
      const localRev = noteRef.current?.revision ?? 0;
      if (meta.revision > localRev) {
        const latest = await fetchNote(targetDate);
        if (currentDateRef.current !== targetDate) return;
        if (dirtyRef.current) {
          setConflict({ serverNote: latest, localMarkdown: contentMdRef.current });
        } else {
          applyServerNote(latest, { showAgentUndo: latest.last_editor === 'agent' });
          void refreshGlobalMetadata(targetDate.slice(0, 7));
        }
      }
    } catch {
      // ignore background poll errors
    }
  }, [applyServerNote, refreshGlobalMetadata]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      void checkExternalUpdates();
    }, POLL_INTERVAL_MS);

    const onFocus = () => {
      void checkExternalUpdates();
    };
    const onBlur = () => {
      if (dirtyRef.current && !conflictRef.current) {
        void flushSave(false);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void checkExternalUpdates();
      }
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [checkExternalUpdates, flushSave]);

  // Midnight rollover check (every 30s)
  useEffect(() => {
    const id = setInterval(() => {
      const nowToday = getTodayDateString();
      if (nowToday !== todayDate) {
        const oldToday = todayDate;
        setTodayDate(nowToday);
        if (currentDateRef.current === oldToday) {
          setMidnightTargetDate(nowToday);
        }
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [todayDate]);

  // Global keyboard shortcuts (docs/UI_UX_SPEC.md §6.1)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === 'Escape') {
        if (lightbox) {
          e.preventDefault();
          setLightbox(null);
          return;
        }
        if (revisionsOpen) {
          e.preventDefault();
          setRevisionsOpen(false);
          return;
        }
        if (searchOpen) {
          e.preventDefault();
          setSearchOpen(false);
          return;
        }
        if (calendarOpen) {
          e.preventDefault();
          setCalendarOpen(false);
          return;
        }
      }

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCalendarOpen(false);
        setRevisionsOpen(false);
        setSearchInitialTag('');
        setSearchOpen((v) => !v);
        return;
      }

      if (mod && e.key === '/') {
        e.preventDefault();
        void (async () => {
          await flushSave(false);
          setSourceMode((v) => !v);
        })();
        return;
      }

      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void flushSave(false).then((saved) => {
          if (saved) showToast('✓ 已保存');
        });
        return;
      }

      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        if (historyStack.length > 0) {
          void handleGoBack();
        } else {
          void navigateToDate(shiftDate(currentDateRef.current, -1));
        }
        return;
      }

      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        void navigateToDate(shiftDate(currentDateRef.current, 1));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    calendarOpen,
    flushSave,
    handleGoBack,
    historyStack.length,
    lightbox,
    navigateToDate,
    revisionsOpen,
    searchOpen,
    showToast,
  ]);

  // Actions
  const handleToggleSource = async () => {
    await flushSave(false);
    setSourceMode((v) => !v);
  };

  const handleAiSummary = async () => {
    await flushSave(false);
    const date = currentDateRef.current;
    const prompt = `请使用 daily-notes 工具读取我 ${date} 的每日笔记与未完成待办，帮我提炼今日核心进展、已完成项、待办与明日建议。`;
    const outcome = await sendMessageToAgent(prompt);
    showToast(outcome === 'sent' ? '✨ 已发送总结指令到对话' : '📋 已复制总结指令，请粘贴到对话执行');
  };

  const handleSendSelectionToChat = async (selectedText: string) => {
    const date = currentDateRef.current;
    const quoted = selectedText
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    const prompt = `关于我在 ${date} 每日笔记中的这段记录：\n${quoted}\n请帮我评估并给出建议。`;
    const outcome = await sendMessageToAgent(prompt);
    showToast(outcome === 'sent' ? '💬 已发送到当前对话' : '📋 已复制引用内容，请粘贴到对话');
  };

  const handleCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(contentMdRef.current);
      showToast('📋 已复制 Markdown 到剪贴板');
    } catch {
      showToast('复制失败：剪贴板不可用');
    }
  };

  const handleCopyResourceUri = async () => {
    const uri = `daily-notes://notes/${currentDateRef.current}`;
    try {
      await navigator.clipboard.writeText(uri);
      showToast(`📎 已复制引用 ${uri}`);
    } catch {
      showToast('复制失败：剪贴板不可用');
    }
  };

  const handleExportMd = async (frontmatter: boolean) => {
    await flushSave(false);
    const date = currentDateRef.current;
    try {
      const mdText = await exportNoteMarkdown(date, frontmatter);
      const blob = new Blob([mdText], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${date}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`⬇ 已导出 ${date}.md`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导出失败');
    }
  };

  const handleUndoAgentUpdate = async () => {
    const date = currentDateRef.current;
    try {
      const { revisions } = await fetchRevisions(date, 10);
      const latestAgentSnap = revisions.find((r) => r.source === 'agent') || revisions[0];
      if (!latestAgentSnap) {
        showToast('未找到可撤销的历史快照');
        return;
      }
      const restored = await restoreRevision({
        date,
        id: latestAgentSnap.id,
        expected_revision: noteRef.current?.revision,
      });
      applyServerNote(restored, { showAgentUndo: false });
      showToast('✓ 已一键恢复到 Agent 修改前版本');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '撤销失败');
    }
  };

  const handleRestoreRevision = async (revisionId: number) => {
    const date = currentDateRef.current;
    try {
      const restored = await restoreRevision({
        date,
        id: revisionId,
        expected_revision: noteRef.current?.revision,
      });
      applyServerNote(restored, { showAgentUndo: false });
      showToast('✓ 已恢复到选定历史快照');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '恢复快照失败');
    }
  };

  const handleApplyCarryOver = async () => {
    const date = currentDateRef.current;
    try {
      const res = await carryOverTodos({
        date,
        action: 'apply',
        source_date: note?.yesterday_pending?.source_date,
      });
      applyServerNote(res.note, { showAgentUndo: false });
      showToast(`📌 已顺延 ${res.carried_count} 项未完成待办`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '顺延待办失败');
    }
  };

  const handleDismissCarryOver = async () => {
    const date = currentDateRef.current;
    try {
      const res = await carryOverTodos({ date, action: 'dismiss' });
      applyServerNote(res.note, { showAgentUndo: false });
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleLinkProject = async (ws: WorkspaceInfo) => {
    const date = currentDateRef.current;
    try {
      const res = await addNoteProject({
        date,
        workspace_uri: ws.uri,
        workspace_name: ws.name,
      });
      setNote((prev) => (prev ? { ...prev, projects: res.projects } : prev));
      void refreshGlobalMetadata(date.slice(0, 7));
    } catch (err) {
      showToast(err instanceof Error ? err.message : '关联项目失败');
    }
  };

  const handleUnlinkProject = async (workspaceUri: string) => {
    const date = currentDateRef.current;
    try {
      const res = await removeNoteProject({ date, workspace_uri: workspaceUri });
      setNote((prev) => (prev ? { ...prev, projects: res.projects } : prev));
      void refreshGlobalMetadata(date.slice(0, 7));
    } catch (err) {
      showToast(err instanceof Error ? err.message : '取消关联失败');
    }
  };

  const liveStats = useMemo(() => {
    const cjk = (contentMd.match(/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g) || []).length;
    const latin = (contentMd.replace(/[\u4E00-\u9FFF]/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length;
    const todos = contentMd.match(/^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s+/gm) || [];
    const done = todos.filter((l) => /\[[xX]\]/.test(l)).length;
    return {
      words: dirty ? cjk + latin : (note?.word_count ?? cjk + latin),
      todoTotal: dirty ? todos.length : (note?.todo_total ?? todos.length),
      todoDone: dirty ? done : (note?.todo_done ?? done),
    };
  }, [contentMd, dirty, note]);

  return (
    <div className="dn-app" data-testid="dn-app">
      <Header
        currentDate={currentDate}
        todayDate={todayDate}
        canGoBack={historyStack.length > 0}
        calendarOpen={calendarOpen}
        searchOpen={searchOpen}
        sourceMode={sourceMode}
        onGoBack={() => void handleGoBack()}
        onPrevDay={() => void navigateToDate(shiftDate(currentDate, -1))}
        onNextDay={() => void navigateToDate(shiftDate(currentDate, 1))}
        onJumpToday={() => void navigateToDate(todayDate)}
        onToggleCalendar={() => {
          setSearchOpen(false);
          setRevisionsOpen(false);
          setCalendarOpen((v) => !v);
        }}
        onToggleSearch={() => {
          setCalendarOpen(false);
          setRevisionsOpen(false);
          setSearchInitialTag('');
          setSearchOpen((v) => !v);
        }}
        onAiSummary={() => void handleAiSummary()}
        onToggleSource={() => void handleToggleSource()}
        onCopyMarkdown={() => void handleCopyMarkdown()}
        onCopyResourceUri={() => void handleCopyResourceUri()}
        onExportMd={(fm) => void handleExportMd(fm)}
        onOpenRevisions={() => {
          setCalendarOpen(false);
          setSearchOpen(false);
          setRevisionsOpen(true);
        }}
      />

      <ProjectBar
        linkedProjects={note?.projects || []}
        activeWorkspaces={activeWorkspaces}
        onLinkProject={(ws) => void handleLinkProject(ws)}
        onUnlinkProject={(uri) => void handleUnlinkProject(uri)}
      />

      <Banners
        midnightTargetDate={midnightTargetDate}
        yesterdayPending={note?.yesterday_pending || null}
        conflict={conflict}
        onSwitchToMidnightToday={() => {
          const target = midnightTargetDate;
          setMidnightTargetDate(null);
          if (target) void navigateToDate(target);
        }}
        onDismissMidnight={() => setMidnightTargetDate(null)}
        onApplyCarryOver={() => void handleApplyCarryOver()}
        onDismissCarryOver={() => void handleDismissCarryOver()}
        onKeepLocalOverwrite={() => void flushSave(true)}
        onLoadServerVersion={() => {
          if (conflict) {
            applyServerNote(conflict.serverNote, { showAgentUndo: false });
          }
        }}
      />

      <main className="dn-main">
        <div className="dn-content-col">
          <NoteEditor
            noteDate={currentDate}
            contentMd={contentMd}
            syncVersion={syncVersion}
            sourceMode={sourceMode}
            knownDates={knownDates}
            recentNoteDates={recentNoteDates}
            onChangeMarkdown={handleMarkdownChange}
            onNavigateDate={(d) => void navigateToDate(d, { pushHistory: true })}
            onClickTag={(tag) => {
              setCalendarOpen(false);
              setRevisionsOpen(false);
              setSearchInitialTag(tag);
              setSearchOpen(true);
            }}
            onSendSelectionToChat={(txt) => void handleSendSelectionToChat(txt)}
            onOpenLightbox={(src, alt) => setLightbox({ src, alt })}
            onNotify={showToast}
          />

          {note && note.backlinks.length > 0 && (
            <section className="dn-backlinks" aria-label="反向引用">
              <div className="dn-backlinks-title">被以下日期引用（{note.backlinks.length}）</div>
              <div className="dn-backlinks-list">
                {note.backlinks.map((bl) => (
                  <button
                    key={bl.date}
                    type="button"
                    className="dn-backlink-chip"
                    onClick={() => void navigateToDate(bl.date, { pushHistory: true })}
                  >
                    <span>📅 {bl.date}</span>
                    {bl.title && <span>· {bl.title}</span>}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>

      <FooterBar
        saveStatus={saveStatus}
        updatedAt={note?.updated_at ?? null}
        wordCount={liveStats.words}
        todoTotal={liveStats.todoTotal}
        todoDone={liveStats.todoDone}
        agentUndoAvailable={agentUndoAvailable}
        onUndoAgentUpdate={() => void handleUndoAgentUpdate()}
        onOpenRevisions={() => setRevisionsOpen(true)}
      />

      <CalendarDrawer
        open={calendarOpen}
        currentDate={currentDate}
        todayDate={todayDate}
        tags={allTags}
        projects={allProjects}
        onSelectDate={(d) => void navigateToDate(d)}
        onClose={() => setCalendarOpen(false)}
      />

      <SearchDrawer
        open={searchOpen}
        todayDate={todayDate}
        initialTag={searchInitialTag}
        tags={allTags}
        projects={allProjects}
        activeWorkspaces={activeWorkspaces}
        onSelectDate={(d) => void navigateToDate(d, { pushHistory: true })}
        onClose={() => setSearchOpen(false)}
      />

      <RevisionsDrawer
        open={revisionsOpen}
        date={currentDate}
        onRestore={handleRestoreRevision}
        onClose={() => setRevisionsOpen(false)}
      />

      <ImageLightbox
        src={lightbox?.src ?? null}
        alt={lightbox?.alt ?? ''}
        onClose={() => setLightbox(null)}
      />

      {toast && (
        <div className="dn-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}
