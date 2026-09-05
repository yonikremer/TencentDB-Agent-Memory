import type { ReactNode } from 'react';
import { Card } from 'tea-component';
import './asset-page-header.css';

interface AssetPageHeaderProps {
  title: string;
  scope: ReactNode;
  agent?: ReactNode;
  actions?: ReactNode;
  subtitle?: ReactNode;
}

/**
 * Shared header for asset page.
 *
 * Responsible only for unifying the title, asset scope, Agent filtering, and visual layout of the action bar; each asset page maintains its own
 * Data requests, permission checks, and button availability, avoiding coupling the business semantics of different assets into generic components.
 */
export function AssetPageHeader({ title, scope, agent, actions, subtitle }: AssetPageHeaderProps) {
  return (
    <Card className="_asset-page-header">
      <Card.Body>
        <div className="_asset-page-header-main">
          <h2 className="_asset-page-header-title">{title}</h2>
          <div className="_asset-page-header-right">
            <div className="_asset-page-header-filters">
              {scope}
              {agent}
            </div>
            {actions && <div className="_asset-page-header-actions">{actions}</div>}
          </div>
        </div>
        {subtitle && <div className="_asset-page-header-subtitle">{subtitle}</div>}
      </Card.Body>
    </Card>
  );
}
