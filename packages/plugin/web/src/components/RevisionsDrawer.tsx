import { useEffect, useState } from 'react';
import { fetchRevisions } from '../lib/api';
import { formatDateTimeCompact } from '../lib/date';
import type { RevisionRecord } from '../types';

interface RevisionsDrawerProps {
  open: boolean;
  date: string;
  onRestore: (revisionId: number) => Promise<void>;
  onClose: () => void;
}

const SOURCE_LABELS: Record<RevisionRecord['source'], string> = {
  agent: 'Agent 写入前快照',
  restore_backup: '回滚前自动备份',
  manual_checkpoint: '手动检查点',
  carry_over_backup: '待办顺延前备份',
};

export function RevisionsDrawer({ open, date, onRestore, onClose }: RevisionsDrawerProps) {
  const [loading, setLoading] = useState(false);
  const [revisions, setRevisions] = useState<RevisionRecord[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetchRevisions(date)
      .then((res) => {
        if (!cancelled) {
          setRevisions(res.revisions);
          setExpandedId(res.revisions[0]?.id ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) setRevisions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, date]);

  if (!open) return null;

  return (
    <section
      className="dn-drawer-overlay"
      data-testid="dn-revisions-drawer"
      aria-label="历史快照"
    >
      <div className="dn-drawer-head" style={{ justifyContent: 'space-between' }}>
        <strong style={{ fontSize: 13 }}>历史快照 · {date}</strong>
        <button type="button" className="dn-btn-sm" onClick={onClose}>
          关闭
        </button>
      </div>

      <div className="dn-drawer-body">
        {loading && <div className="dn-empty-muted">加载快照列表中…</div>}

        {!loading && revisions.length === 0 && (
          <div className="dn-empty-muted">该日期暂无历史快照记录</div>
        )}

        {!loading &&
          revisions.map((rev) => {
            const expanded = expandedId === rev.id;
            return (
              <div key={rev.id} className="dn-result-card" style={{ cursor: 'default' }}>
                <div className="dn-result-meta">
                  <span style={{ fontWeight: 600, color: 'var(--dn-fg)' }}>
                    rev {rev.revision} · {SOURCE_LABELS[rev.source] || rev.source}
                  </span>
                  <span>{formatDateTimeCompact(rev.created_at)}</span>
                </div>

                {rev.summary && (
                  <div style={{ fontSize: 12, color: 'var(--dn-fg-2)' }}>{rev.summary}</div>
                )}

                {expanded ? (
                  <pre className="dn-modal-pre" style={{ marginTop: 4, maxHeight: 200, overflow: 'auto' }}>
                    {rev.content_md || '(空白笔记)'}
                  </pre>
                ) : (
                  <div className="dn-result-snippet">{rev.preview || '(空白笔记)'}</div>
                )}

                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    type="button"
                    className="dn-btn-sm"
                    onClick={() => setExpandedId(expanded ? null : rev.id)}
                  >
                    {expanded ? '收起正文' : '查看全文'}
                  </button>
                  <button
                    type="button"
                    className="dn-btn-sm primary"
                    disabled={restoringId !== null}
                    onClick={async () => {
                      setRestoringId(rev.id);
                      try {
                        await onRestore(rev.id);
                        onClose();
                      } finally {
                        setRestoringId(null);
                      }
                    }}
                  >
                    {restoringId === rev.id ? '恢复中…' : '恢复此版本'}
                  </button>
                </div>
              </div>
            );
          })}
      </div>
    </section>
  );
}
