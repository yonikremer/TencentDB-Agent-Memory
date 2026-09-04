import type { KernelHttpPort } from '../ports/kernel-http-port.js';
import type { SkillKernelPort } from '../ports/skill-kernel-port.js';
import { toKernelCredentials, type MetaCallContext } from '../types.js';

/**
 * Skill data plane adapter based on fetch: POST /v3/skill/{action}.
 *
 * skill body 使用嵌套 pagination（不是顶层 limit/offset），故不做 meta 的
 * sanitizeBody is cropped and transmitted as is. The credentials and meta share the same set (instance + api_key +
 * user_key), user_key is always transparently transmitted (skill does not have authentication-free actions such as auth/verify).
 */
export class FetchSkillKernelAdapter implements SkillKernelPort {
  constructor(
    private readonly http: KernelHttpPort,
    private readonly timeoutMs: number,
  ) {}

  invoke(action: string, body: Record<string, unknown>, ctx: MetaCallContext) {
    const cred = toKernelCredentials(ctx, { timeoutMs: this.timeoutMs });
    return this.http.postEnvelope(`/v3/skill/${action}`, body, cred);
  }
}
