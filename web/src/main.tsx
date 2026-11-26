import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/theme.css';
import './styles/editor.css';

interface RootErrorBoundaryProps {
  children: ReactNode;
}

interface RootErrorBoundaryState {
  error: Error | null;
}

class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[daily-notes ui] render error:', error, info);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div
          role="alert"
          style={{
            padding: 16,
            fontFamily: 'var(--dn-font, system-ui, sans-serif)',
            color: 'var(--dn-fg, #1d1f21)',
            background: 'var(--dn-bg, #f7f7f8)',
            height: '100%',
            overflow: 'auto',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>每日笔记渲染失败</div>
          <div style={{ fontSize: 12, marginBottom: 10 }}>{error.message || String(error)}</div>
          {error.stack && (
            <pre
              style={{
                fontSize: 11,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                padding: 8,
                borderRadius: 6,
                background: 'var(--dn-card, rgba(127,127,127,0.1))',
                marginBottom: 12,
              }}
            >
              {error.stack}
            </pre>
          )}
          <button
            type="button"
            className="dn-btn-sm primary"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');

if (typeof window !== 'undefined' && rootEl) {
  window.addEventListener('error', (event) => {
    if (rootEl.childElementCount > 0) return;
    const message =
      event.error instanceof Error
        ? event.error.stack || event.error.message
        : event.message || '未知启动错误';
    const box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'padding:16px;font-family:system-ui,sans-serif;font-size:12px;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:8px;';
    title.textContent = '每日笔记启动失败';
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:0;';
    pre.textContent = message;
    box.append(title, pre);
    rootEl.replaceChildren(box);
  });
}

createRoot(rootEl!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
