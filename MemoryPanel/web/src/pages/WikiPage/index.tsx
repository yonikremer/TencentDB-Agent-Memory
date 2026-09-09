import { useParams } from 'react-router-dom';
import { ResourcePage } from '@/pages/ResourcePage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { isWikiTab } from '@/lib/asset-routes';
import WikiSourcesPanel from './components/WikiSourcesPanel';

export function WikiPage() {
  const { wikiTab } = useParams<{ wikiTab?: string }>();
  if (wikiTab && !isWikiTab(wikiTab)) return <NotFoundPage />;
  return (
    <ResourcePage>
      <WikiSourcesPanel />
    </ResourcePage>
  );
}
