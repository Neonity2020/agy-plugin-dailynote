import { useState } from 'react';
import type { ConflictState, YesterdayPending } from '../types';

interface BannersProps {
  midnightTargetDate: string | null;
  yesterdayPending: YesterdayPending | null;
  conflict: ConflictState | null;
  onSwitchToMidnightToday: () => void;
  onDismissMidnight: () => void;
  onApplyCarryOver: () => void;
  onDismissCarryOver: () => void;
  onKeepLocalOverwrite: () => void;
  onLoadServerVersion: () => void;
}

export function Banners({
  midnightTargetDate,
  yesterdayPending,
  conflict,
  onSwitchToMidnightToday,
  onDismissMidnight,
  onApplyCarryOver,
  onDismissCarryOver,
  onKeepLocalOverwrite,
  onLoadServerVersion,
}: BannersProps) {
  const [diffModalOpen, setDiffModalOpen] = useState(false);

  if (!midnightTargetDate && !yesterdayPending && !conflict) {
    return null;
  }

  return (
    <div className="dn-banners">
      {conflict && (
        <div className="dn-banner warning" data-testid="dn-conflict-banner" role="alert">
          <div className="dn-banner-text">
            <span>⚠️</span>
            <span>Agent 刚刚更新了本篇笔记，而你有未保存编辑</span>
          </div>
          <div className="dn-banner-actions">
            <button type="button" className="dn-btn-sm primary" onClick={onKeepLocalOverwrite}>
              保留我的并覆盖
            </button>
            <button type="button" className="dn-btn-sm" onClick={onLoadServerVersion}>
              加载 Agent 版本
            </button>
            <button type="button" className="dn-btn-sm ghost" onClick={() => setDiffModalOpen(true)}>
              查看对比
            </button>
          </div>
        </div>
      )}

      {!conflict && yesterdayPending && yesterdayPending.count > 0 && (
        <div className="dn-banner info" data-testid="dn-carryover-banner">
          <div className="dn-banner-text">
            <span>📌</span>
            <span>
              {yesterdayPending.source_date} 有 {yesterdayPending.count} 项未完成待办
            </span>
          </div>
          <div className="dn-banner-actions">
            <button type="button" className="dn-btn-sm primary" onClick={onApplyCarryOver}>
              一键顺延
            </button>
            <button type="button" className="dn-btn-sm ghost" onClick={onDismissCarryOver}>
              忽略
            </button>
          </div>
        </div>
      )}

      {midnightTargetDate && (
        <div className="dn-banner info" data-testid="dn-midnight-banner">
          <div className="dn-banner-text">
            <span>🌙</span>
            <span>新的一天 ({midnightTargetDate}) 已开始</span>
          </div>
          <div className="dn-banner-actions">
            <button type="button" className="dn-btn-sm primary" onClick={onSwitchToMidnightToday}>
              切换到今天
            </button>
            <button type="button" className="dn-btn-sm ghost" onClick={onDismissMidnight}>
              留在当前页
            </button>
          </div>
        </div>
      )}

      {conflict && diffModalOpen && (
        <div
          className="dn-modal-backdrop"
          onClick={() => setDiffModalOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="版本对比"
        >
          <div className="dn-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="dn-modal-head">
              <span>服务端最新内容 (rev {conflict.serverNote.revision}) vs 本地草稿</span>
              <button
                type="button"
                className="dn-btn-sm ghost"
                onClick={() => setDiffModalOpen(false)}
              >
                关闭
              </button>
            </div>
            <div className="dn-modal-body">
              <div style={{ marginBottom: 8, fontWeight: 600 }}>Agent 最新版本（可复制合并）：</div>
              <pre className="dn-modal-pre">{conflict.serverNote.content_md || '(空)'}</pre>
              <div style={{ margin: '12px 0 8px', fontWeight: 600 }}>你当前的未保存内容：</div>
              <pre className="dn-modal-pre">{conflict.localMarkdown || '(空)'}</pre>
              <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="dn-btn-sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(conflict.serverNote.content_md);
                  }}
                >
                  复制 Agent 版本
                </button>
                <button
                  type="button"
                  className="dn-btn-sm"
                  onClick={() => {
                    setDiffModalOpen(false);
                    onLoadServerVersion();
                  }}
                >
                  放弃本地并加载 Agent 版本
                </button>
                <button
                  type="button"
                  className="dn-btn-sm primary"
                  onClick={() => {
                    setDiffModalOpen(false);
                    onKeepLocalOverwrite();
                  }}
                >
                  保留我的并覆盖
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
