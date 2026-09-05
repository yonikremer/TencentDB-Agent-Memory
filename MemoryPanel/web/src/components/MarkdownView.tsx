/**
 * MarkdownView — Unified Markdown rendering component.
 *
 * Skill details / Memory details and other pages share the same rendering and display style:
 * ReactMarkdown + remark-gfm, with the shell being a Tea token border box
 * (see markdown-view.css), without using tailwind semantic colors or inline styles.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import './markdown-view.css';

export function MarkdownView({ children, className, bare }: { children: string; className?: string; bare?: boolean }) {
  return (
    <div className={`_md-view${bare ? ' _md-view--bare' : ''} prose prose-slate max-w-none${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
