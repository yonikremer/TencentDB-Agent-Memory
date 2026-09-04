/**
 * WorkBuddy session-init layer unified export.
 *
 * ⚠️ Strict independence rule: This barrel only exposes workbuddy's own types and entry points; it no longer re-exports
 * other clients' session-init content. The caller (workbuddyHandler) obtains all
 * necessary interfaces from here in one go.
 */

export {
  handleWorkbuddySessionInit,
  type WorkbuddySessionInitResult,
  type WorkbuddyRequestContext,
} from "./init.js";
