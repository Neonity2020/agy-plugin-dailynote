import { formatTimeShort } from '../lib/date';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface FooterBarProps {
  saveStatus: SaveStatus;
  updatedAt: string | null;
  wordCount: number;
  todoTotal: number;
  todoDone: number;
  agentUndoAvailable: boolean;
  onUndoAgentUpdate: () => void;
  onOpenRevisions: () => void;
}

export function FooterBar({
  saveStatus,
  updatedAt,
  wordCount,
  todoTotal,
  todoDone,
  agentUndoAvailable,
  onUndoAgentUpdate,
  onOpenRevisions,
}: FooterBarProps) {
  let statusText = '空白笔记';
  if (saveStatus === 'saving') statusText = '保存中…';
  else if (saveStatus === 'dirty') statusText = '编辑中…';
  else if (saveStatus === 'error') statusText = '⚠️ 保存失败';
  else if (saveStatus === 'saved' || updatedAt) {
    const time = formatTimeShort(updatedAt);
    statusText = time ? `✓ 已保存 ${time}` : '✓ 已保存';
  }

  return (
    <footer className="dn-footer" data-testid="dn-footer-status">
      <div className="dn-footer-left">
        <span>{statusText}</span>
        <span>·</span>
        <span>{wordCount} 字</span>
        {todoTotal > 0 && (
          <>
            <span>·</span>
            <span>
              {todoDone}/{todoTotal} 待办
            </span>
          </>
        )}
      </div>

      <div className="dn-footer-right">
        {agentUndoAvailable && (
          <>
            <button
              type="button"
              className="dn-agent-pill"
              data-testid="dn-agent-undo-btn"
              onClick={onUndoAgentUpdate}
              title="一键恢复到 Agent 更新前的快照"
            >
              ✨ Agent 已更新 · 一键撤销
            </button>
            <button
              type="button"
              className="dn-btn-sm ghost"
              style={{ height: 20, padding: '0 6px' }}
              onClick={onOpenRevisions}
            >
              快照
            </button>
          </>
        )}
      </div>
    </footer>
  );
}
