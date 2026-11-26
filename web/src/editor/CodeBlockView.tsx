import { useState } from 'react';
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

const LANGUAGES = [
  { value: '', label: 'Plain' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'python', label: 'Python' },
  { value: 'bash', label: 'Bash / Shell' },
  { value: 'sql', label: 'SQL' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'markdown', label: 'Markdown' },
];

export function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const [copied, setCopied] = useState(false);
  const currentLang = String(node.attrs.language || '').toLowerCase();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(node.textContent || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable in restricted contexts
    }
  };

  return (
    <NodeViewWrapper className="dn-codeblock">
      <div className="dn-codeblock-header" contentEditable={false}>
        <select
          className="dn-codeblock-lang"
          aria-label="代码块语言"
          value={currentLang}
          onChange={(e) => updateAttributes({ language: e.target.value || null })}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value || 'plain'} value={lang.value}>
              {lang.label}
            </option>
          ))}
          {currentLang && !LANGUAGES.some((l) => l.value === currentLang) && (
            <option value={currentLang}>{currentLang}</option>
          )}
        </select>
        <button
          type="button"
          className="dn-codeblock-copy"
          onClick={handleCopy}
          title="复制代码块"
        >
          {copied ? '✓ 已复制' : '复制'}
        </button>
      </div>
      <pre>
        <NodeViewContent as="code" />
      </pre>
    </NodeViewWrapper>
  );
}
