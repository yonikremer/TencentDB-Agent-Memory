/**
 * Tea component bridging tool
 *
 * Provide a convenient way to use the Tea component in existing code,
 * Gradually replace native HTML elements and custom implementations.
 *
 Usage:
 *   import { tea } from '@/lib/tea-bridge';
 *   tea.confirm({ message: 'Confirm delete?' }).then(ok => { ... });
 *   tea.notify.success('Operation successful');
 *   tea.notify.error('Load failed');  // Show a notification card in the top-right corner, which needs to be manually closed; it won't disappear in an instant
 *   tea.notify.error(err);  // Pass Error / ApiError, automatically extract message + request_id
 */

import { getErrorMessage } from './error-message';
import { Modal, message, notification } from 'tea-component';
import i18n from '@/i18n';

function t(key: string, opts?: Record<string, unknown>): string {
  return i18n.t(key, opts);
}

/**
 * Structured error notification input — suitable for scenarios that require displaying title + detail + requestId.
 */
interface StructuredErrorInput {
  title?: string;
  detail?: string;
  requestId?: string;
}

/**
 * Attempt to extract request_id from the unknown error object as much as possible.
 * Support ApiError (name === 'ApiError'), SkillApiError, KnowledgeApiError, etc.
 */
function extractRequestId(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'requestId' in err) {
    const v = (err as { requestId?: unknown }).requestId;
    if (typeof v === 'string' && v) return v;
  }
  if (err && typeof err === 'object' && 'request_id' in err) {
    const v = (err as { request_id?: unknown }).request_id;
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

export const tea = {
  /**
   * Confirmation Dialog — Alternative to confirm()
   */
  confirm: async (opts: {
    message: string;
    description?: string;
    okText?: string;
    cancelText?: string;
  }) => {
    return Modal.confirm({
      message: opts.message,
      description: opts.description,
      okText: opts.okText ?? t('teaBridge.confirm.ok'),
      cancelText: opts.cancelText ?? t('teaBridge.confirm.cancel'),
    });
  },

  /**
   * Message prompt
   *
   * - success:  lightweight toast (disappears in one flash, does not interrupt the operation)
   * - error:    notification card in the top-right corner (requires manual dismissal, ensuring the user sees the error message)
   * - warning:   notification card in the top-right corner (same as error, requires manual dismissal)
   * - info:      notification card in the top-right corner
   *
   * Previously, errors/warnings used message.error (toast), which disappeared automatically after 3 seconds,
   * Users often couldn't see the error prompts because they disappeared before they were noticed. After switching to notification, the error prompts
   * remain in the top-right corner until the user manually closes them, ensuring they are not missed.
   *
   * error accepts three forms:
   *   - string: used directly as description
   *   - Error / ApiError / SkillApiError / KnowledgeApiError: automatically extract message + request_id
   *   - StructuredErrorInput { title?, detail?, requestId? }: structured format
   */
  notify: {
    success: (msg: string) => message.success({ content: msg }),
    error: (msg: unknown) => {
      // Structured input parameters { title?, detail?, requestId? }
      if (msg && typeof msg === 'object' && !((msg as unknown) instanceof Error) && ('title' in msg || 'detail' in msg || 'requestId' in msg)) {
        const input = msg as StructuredErrorInput;
        const desc = input.requestId
          ? input.detail
            ? `${input.detail}\nrequest_id: ${input.requestId}`
            : `request_id: ${input.requestId}`
          : input.detail;
        notification.error({
          title: input.title ?? t('teaBridge.notify.errorTitle'),
          description: desc,
        });
        return;
      }
      // Error / string / others — go to getErrorMessage to extract friendly message
      const friendly = getErrorMessage(msg);
      const requestId = extractRequestId(msg);
      const desc = requestId
        ? `${friendly}\nrequest_id: ${requestId}`
        : friendly;
      notification.error({
        title: t('teaBridge.notify.errorTitle'),
        description: desc,
      });
    },
    warning: (msg: string) =>
      notification.warning({
        title: t('teaBridge.notify.warningTitle'),
        description: msg,
      }),
    info: (msg: string) =>
      notification.success({ description: msg }),
  },

  /**
   * Complex notification (with custom title)
   */
  notification: {
    success: (title: string, description?: string) =>
      notification.success({ title, description }),
    error: (title: string, description?: string) =>
      notification.error({ title, description: description ? getErrorMessage(description) : undefined }),
    warning: (title: string, description?: string) =>
      notification.warning({ title, description }),
  },

  /**
   * Confirm deletion
   */
  confirmDelete: (name: string, detail?: string) =>
    Modal.confirm({
      message: t('teaBridge.confirmDelete.message', { name }),
      description: detail ?? t('teaBridge.confirmDelete.desc'),
      okText: t('teaBridge.confirmDelete.ok'),
      cancelText: t('teaBridge.confirm.cancel'),
    }),
};

/**
 * "Confirm to execute" helper function - converging the large amount of repetitive
 * `tea.confirm(...) → if (!ok) return → try/catch → tea.notify.error` boilerplate.
 *
 * Execute action after user confirmation; if action throws an error, default to tea.notify.error(err) by default.
 * (An onError can be passed to customize the error notification, such as with i18n fallback text.)
 *
 * @returns whether the user confirms and successfully executes (both cancel and execution failure return false)
 */
export async function confirmThenRun(
  opts: {
    message: string;
    description?: string;
    okText?: string;
    cancelText?: string;
  },
  action: () => Promise<void> | void,
  onError?: (err: unknown) => void,
): Promise<boolean> {
  const ok = await tea.confirm(opts);
  if (!ok) return false;
  try {
    await action();
    return true;
  } catch (err) {
    if (onError) {
      onError(err);
    } else {
      tea.notify.error(err);
    }
    return false;
  }
}
