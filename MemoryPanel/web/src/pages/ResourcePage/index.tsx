/**
 * Resource Management Page Common Shell — Shared by Wiki / Code / Skills / Memory
 *
 * Both admin and member display their content normally
 * It is wrapped by ConsoleLayout's Content.Body here, and it is a direct child node.
 */
import type { ReactNode } from 'react';
import './styles/page-style.css';

export function ResourcePage({ children }: { children: ReactNode }) {
  return (
    <div className="_memory-page-body">
      {children}
    </div>
  );
}
