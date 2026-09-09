import { useParams } from 'react-router-dom';
import { ResourcePage } from '@/pages/ResourcePage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { isMemoryLayer } from '@/lib/asset-routes';
import ChatMemoryPanel from './components/ChatMemoryPanel';

export function ChatMemoryPage() {
  const { layer } = useParams<{ layer?: string }>();
  if (layer && !isMemoryLayer(layer)) return <NotFoundPage />;
  return (
    <ResourcePage>
      <ChatMemoryPanel />
    </ResourcePage>
  );
}
