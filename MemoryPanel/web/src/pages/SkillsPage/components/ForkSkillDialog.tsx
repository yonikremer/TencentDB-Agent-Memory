/**
 * ForkSkillDialog — "Copy a skill to a certain agent, and that copy can be edited by the agent".
 *
 * Difference from "Authorization (asset visibility=team + acl/grant)":
 *   - Authorization → Switch to share or acl/grant via the "My Assets" tab, without copying content; others
 *     get read/usage permissions on the same skill;
 *   - fork (this dialog) → Pull the source skill's SKILL.md, **keeping the original name + the target agent as owner**
 *     by calling skill-api.createSkill to save an independent copy, after which that agent can write.
 *
 * Naming convention: copies **continue to use the original skill name from the source**, without adding suffixes. The unique constraint for skills is based on
 * (team_id, owner_agent_id, name): within the same team, multiple copies with the same name are allowed (belonging to different agents),
 * but if a skill with the same name already exists under the target agent, the backend will reject it (42201); this intercepts it in advance and prompts.
 *
 * Implement: follow the three steps of "getSkill(source) → readSkillFile(attachments) → createSkill(new)".
 */

import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Select } from 'tea-component';
import { useTranslation } from 'react-i18next';
import '@/components/asset/allocate-dialog.css';

import {
  createSkill,
  getSkill,
  listSkills,
  readSkillFile,
  type SkillSummary,
  type SkillResourcePayload,
} from '@/lib/api/skill-api';

/**
 * Rewrite the `name` field in the frontmatter of SKILL.md, ensuring that the DB record name matches the file content.
 * Only replace the `name:` line within the first `--- ... ---` frontmatter block; if there is no frontmatter, return it as is.
 */
function rewriteFrontmatterName(content: string, newName: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return content;
  const fmBody = fmMatch[1];
  if (!/^\s*name\s*:/m.test(fmBody)) return content; // No name field, do not forcefully insert
  const newFmBody = fmBody.replace(/^(\s*name\s*:\s*).*/m, `$1${newName}`);
  return content.replace(fmBody, newFmBody);
}

export default function ForkSkillDialog(props: {
  /** The name of the source skill to fork */
  skillName: string;
  /** skill_id required for v3 API */
  skillId: string;
  agents: Array<{ id: string; name: string }>;
  /** Current team ID (required for v3 API) */
  teamId: string;
  /** Current user ID (required for v3 API) */
  userId: string;
  onClose: () => void;
  onForked: (newSkill: SkillSummary) => void;
}) {
  const { t } = useTranslation();
  const [agentId, setAgentId] = useState(props.agents[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // The copy name defaults to the original name of the source skill and can be edited by the user. Uniqueness is enforced via owner_agent_id,
  // and duplicate names are not allowed under the same agent (backend 42201); the submit below will intercept this in advance.
  const [newName, setNewName] = useState(props.skillName);

  async function submit(): Promise<void> {
    if (!agentId) {
      setError(t('forkSkill.error.noAgent'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // Step 1: Pull source skill details (including content + manifest).
      const full = await getSkill({
        skill_id: props.skillId,
        team_id: props.teamId,
        include_content: true,
        include_manifest: true,
      });

      // Step 2: Defensive check - Intercept early if a skill with the same name already exists under the target agent to avoid backend 42201.
      const existing = await listSkills({
        team_id: props.teamId,
        filters: { owner_agent_id: agentId, status: ['active'] },
        pagination: { limit: 100 },
      });
      if (existing.items.some((s) => s.name === newName)) {
        throw new Error(
          t('forkSkill.error.duplicate', { agent: agentId, name: newName })
        );
      }

      // Step 3: Copy associated resource files (readSkillFile one by one; skip individual failures, do not block the main flow).
      const resources: SkillResourcePayload[] = [];
      for (const entry of full.manifest ?? []) {
        try {
          const f = await readSkillFile({
            skill_id: props.skillId,
            team_id: props.teamId,
            path: entry.path,
          });
          resources.push({
            path: f.path,
            content: f.content,
            encoding: f.encoding,
            mime_type: f.mime_type || undefined,
            is_executable: entry.is_executable || undefined,
          });
        } catch {
          /* If a single resource read fails, skip it and do not block the fork main flow */
        }
      }

      // Step 4: Create a skill (v3 API) with (editable) copy name + target agent as owner.
      // If the user changes the name, synchronously update the name field in the frontmatter of SKILL.md, keeping DB and file consistent.
      const trimmedName = newName.trim();
      const finalContent = trimmedName !== props.skillName
        ? rewriteFrontmatterName(full.content, trimmedName)
        : full.content;
      const created = await createSkill({
        user_id: props.userId,
        team_id: props.teamId,
        agent_id: agentId,
        name: trimmedName,
        content: finalContent,
        resources: resources.length ? resources : undefined,
      });

      const resourceInfo = resources.length > 0
        ? t('forkSkill.success.withResources', { name: props.skillName, agent: agentId, count: resources.length })
        : (full.manifest?.length ?? 0) > 0
          ? t('forkSkill.success.allFailed', { name: props.skillName, agent: agentId, count: full.manifest?.length ?? 0 })
          : t('forkSkill.success.noResources', { name: props.skillName, agent: agentId });
      setSuccess(resourceInfo);
      setTimeout(() => props.onForked(created), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible caption={t('forkSkill.caption')} size="s" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          <Form.Item label={t('forkSkill.descLabel')}>
            <Form.Text>{t('forkSkill.desc', { name: props.skillName })}</Form.Text>
          </Form.Item>
          <Form.Item label={t('forkSkill.agent')} required>
            <Select
              size="full"
              value={agentId}
              onChange={setAgentId}
              placeholder={t('forkSkill.agent.placeholder')}
              options={props.agents.map((a) => ({ value: a.id, text: `${a.id} · ${a.name}` }))}
            />
          </Form.Item>
          <Form.Item label={t('forkSkill.copyName')} required>
            <Input
              size="full"
              value={newName}
              onChange={setNewName}
              placeholder={t('forkSkill.copyName.placeholder')}
            />
          </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
          {success && <Form.Item><Alert type="success">{success}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={submitting || !agentId || !newName.trim()} loading={submitting}>{t('forkSkill.submit')}</Button>
        <Button onClick={props.onClose} disabled={submitting}>{t('forkSkill.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
