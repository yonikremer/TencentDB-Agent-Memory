import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, Text } from 'tea-component';

/** Full-page 404 — unknown route or asset id that doesn't exist. */
export function NotFoundPage({ message }: { message?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="_memory-page-body">
      <Card>
        <Card.Body>
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <div className="text-4xl font-bold">404</div>
            <Text theme="strong">{t('notFound.title')}</Text>
            <div className="mt-2">
              <Text theme="label">{message || t('notFound.desc')}</Text>
            </div>
            <div className="mt-4">
              <Button type="primary" onClick={() => navigate('/', { replace: true })}>
                {t('notFound.back')}
              </Button>
            </div>
          </div>
        </Card.Body>
      </Card>
    </div>
  );
}
