/**
 * ImportSkillDialog — Import Skill dialog. Supports only two import methods:
 *
 *   1. Directory import (directory)
 *       User selects a local directory, the frontend splits the files inside into "main file" (SKILL.md,
 *       (must be in the root directory or <skill-name>/) and "resource files" (other files, keep
 *       relative path). Run v3 create to persist to database at once (including resources, new ones are v1).
 *       Browser directory selection has no Tea component equivalent, preserving native <input type="file"
 *      webkitdirectory>, hidden and triggered by Tea Button.
 *
 *   2. Conversational Introduction (session)
 *       User pastes a conversation with the agent (the JSON input parameter for the skill/extract interface,
 *       containing a messages array). The frontend only performs JSON validation + overwrites the identity field
 *       with the current context ID, then calls extractSkills. The server-side LLM automatically summarizes
 *       the skill's name / description / content from the conversation, and directly persists to the database
 *       through tool calls (following the same chain as SkillCore.create/update), without going through review.
 *       Support sync (directly return the result) and async (return a task_id, which is considered accepted,
 *       prompt the user with the estimated result time before closing the popup, and do not block the frontend with polling -- the result will be
 *       asynchronously accumulated into that agent's skill list, and the user can see it manually on the next refresh).
 *
 * Remove note: The original "paste SKILL.md text" mode is now offline — directory import has replaced it
 * This scenario, and users handwriting frontmatter are very prone to pitfalls (missing name/description,
 * YAML syntax error), it is more stable to guide users to place SKILL.md properly via directory import.
 */

import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  createSkill,
  extractSkills,
  type SkillResourcePayload,
  type ExtractParams,
} from '@/lib/api/skill-api';
import { Alert, Button, Form, Input, Modal, Segment, Select } from 'tea-component';
import { FolderOpenIcon } from 'tea-icons-react';
import i18n from '@/i18n';
import '../styles/import-skill-dialog.css';

type Mode = 'directory' | 'session';

/**
 * Read a File as base64. Used for binary/executable resources where we
 * can't safely treat bytes as utf8.
 */
async function readAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  // Browser-side base64: chunked to avoid stack-overflow on big files.
  let bin = '';
  const arr = new Uint8Array(buf);
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function readAsUtf8(file: File): Promise<string> {
  return file.text();
}

/**
 * Heuristic: extension-based + small-size = text. The gateway already
 * enforces a 5MB cap, but we want to send big binaries as base64 not
 * as a 5MB-of-mojibake string.
 */
function looksLikeText(file: File): boolean {
  const lower = file.name.toLowerCase();
  if (/\.(md|markdown|txt|json|yaml|yml|sh|js|ts|tsx|py|go|rs|toml|html|css|csv|conf|cfg)$/.test(lower)) {
    return true;
  }
  if (file.size < 64 * 1024) return true;
  return false;
}

/**
 * Walk webkitRelativePath like "my-skill/SKILL.md" or "my-skill/files/scripts/x.sh".
 * Returns { skillName, mainFile, resources }; resource paths are
 * normalised relative to `<skill-name>/files/`.
 */
function partitionFiles(files: File[]): {
  skillName: string | null;
  mainFile: File | null;
  resources: Array<{ path: string; file: File }>;
  warning?: string;
} {
  let mainFile: File | null = null;
  let mainRelPath = '';
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    const segments = rel.split('/');
    const lastSegment = segments[segments.length - 1] ?? '';
    if (lastSegment === 'SKILL.md') {
      // Prefer the shallowest SKILL.md (depth = number of segments).
      if (!mainFile || segments.length < mainRelPath.split('/').length) {
        mainFile = f;
        mainRelPath = rel;
      }
    }
  }
  if (!mainFile) {
    return {
      skillName: null,
      mainFile: null,
      resources: [],
      warning: i18n.t('importSkill.directory.warning'),
    };
  }
  const mainSegments = mainRelPath.split('/');
  const baseDir = mainSegments.slice(0, -1).join('/');
  const skillName = mainSegments.length >= 2 ? mainSegments[mainSegments.length - 2] : null;

  const resources: Array<{ path: string; file: File }> = [];
  for (const f of files) {
    if (f === mainFile) continue;
    let rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    if (baseDir && rel.startsWith(baseDir + '/')) {
      rel = rel.slice(baseDir.length + 1);
    }
    if (rel.startsWith('files/')) rel = rel.slice('files/'.length);
    if (!rel) continue;
    resources.push({ path: rel, file: f });
  }
  return { skillName, mainFile, resources };
}

export default function ImportSkillDialog(props: {
  onClose: () => void;
  onImported: () => void;
  /** Currently active team (skill attribution, required for create) */
  teamId: string;
  /** Import target: 'team' = team pool (default), 'fixed' = agent fixed assets. */
  target?: 'team' | 'fixed';
  /** Agent roster (for fixed-target agent selector). */
  agents?: Array<{ id: string; name: string }>;
  /** Pre-selected agent id (when target='fixed'). */
  agentId?: string;
  /** Current user ID (required for v3 API) */
  userId: string;
}) {
  const [mode, setMode] = useState<Mode>('directory');
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  // session-import: User pastes the input parameters of the skill/extract interface (including the messages array).
  // The server-side LLM independently summarizes the skill's name / description / content from messages.
  const [sessionPayload, setSessionPayload] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(props.agentId ?? '');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  const partition = useMemo(() => (mode === 'directory' ? partitionFiles(pickedFiles) : null), [
    mode,
    pickedFiles
  ]);

  async function submit(): Promise<void> {
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const agentId = props.target === 'fixed' ? (selectedAgentId || props.agentId || '') : '';
      if (props.target === 'fixed' && !agentId) {
        throw new Error(t('importSkill.error.noAgent'));
      }
      if (!props.teamId) throw new Error(t('importSkill.error.noTeam'));

      // ==== Dialogue Import: Directly Call skill/extract ====
      if (mode === 'session') {
        const raw = sessionPayload.trim();
        if (!raw) throw new Error(t('importSkill.error.noPayload'));
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          throw new Error(t('importSkill.error.jsonParse', { msg: e instanceof Error ? e.message : String(e) }));
        }
        if (!Array.isArray((parsed as { messages?: unknown }).messages)) {
          throw new Error(t('importSkill.error.noMessages'));
        }
        const msgs = (parsed as { messages: unknown[] }).messages;
        if (msgs.length === 0) {
          throw new Error(t('importSkill.error.emptyMessages'));
        }
        // Backend extract interface limits messages to a maximum of 500 (see iWiki §3.13),
        if (msgs.length > 500) {
          throw new Error(t('importSkill.error.tooManyMessages', { count: msgs.length }));
        }

        // Assemble extract input parameters. The identity fields (user_id/team_id/agent_id) are forcibly overridden by the current UI context
        // to prevent users from mistakenly sticking wrong teams or forging identities — see <security_rules> §3.
        // space_id does not need to be explicitly passed: consistent with other skill interfaces, the backend retrieves it from the X-Tdai-Service-Id
        // header (= panelSession.instanceId). session_id / task_id are also not passed,
        // letting the backend generate them — to avoid frontend hardcoding "default" / "import-${Date.now()}" polluting archive paths.
        // The extract interface itself does not accept name/description fields (skill name and description are provided by the LLM
        // Independently summarized from messages), even if these two fields are included in the JSON, they will not be passed to the server.
        const extractParams: ExtractParams = {
          user_id: props.userId,
          team_id: props.teamId,
          agent_id: agentId || props.userId,
          task_id: typeof parsed.task_id === 'string' && parsed.task_id ? parsed.task_id : undefined,
          session_id:
            typeof parsed.session_id === 'string' && parsed.session_id
              ? parsed.session_id
              : undefined,
          messages: parsed.messages as ExtractParams['messages'],
          reason:
            typeof parsed.reason === 'string' && parsed.reason
              ? parsed.reason
              : 'manual import from console',
          options:
            typeof parsed.options === 'object' && parsed.options !== null
              ? (parsed.options as ExtractParams['options'])
              : undefined,
        };

        // The backend extract always goes through the archive → agent queue → worker async chain,
        // it always returns task_id (there is no sync candidates branch anymore). The frontend
        // treats a received task_id as "accepted", prompts the estimated result time, and then closes the popup;
        // the result is asynchronously written to the skill table by SkillCoreSink, and the user can refresh the list to see it.
        //
        // Frontend soft timeout fallback (5s): the archive pipeline involves sequential COS reads/writes (read _tasks.json →
        // write data-xxx.jsonl → write _tasks.json), so when COS is slow, the overall duration easily exceeds
        // the Panel backend 15s hard timeout (KERNEL_TIMEOUT/504), which falsely reports failure in the UI.
        // In reality, the request has already been queued on the server, and the backend will continue to complete archive. Therefore,
        // if the backend responds within 5s, proceed with the real result; if no response is received by the 5s mark, directly display the "Accepted" text,
        // and no longer block the user -- the backend call continues running in the browser fetch layer (not abort), worst case
        // The situation is that after 15s, the Panel returns 504, and our catch silently swallows it (the user has already seen success).
        const TIMEOUT_MS = 5000;
        let softTimedOut = false;
        const extractPromise = extractSkills(extractParams).catch((e) => {
          // If the success message has already been shown with a soft timeout, silently swallow subsequent errors (such as 504).
          if (softTimedOut) return null;
          throw e;
        });
        const timeoutPromise = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), TIMEOUT_MS),
        );
        const raced = await Promise.race([extractPromise, timeoutPromise]);
        if (raced === 'timeout') {
          softTimedOut = true;
          setResult(t('importSkill.result.session.accepted'));
        } else if (raced) {
          setResult(t('importSkill.result.session', { taskId: raced.task_id }));
        } else {
          // the branch where extractPromise is caught as null after soft timeout (normally won't be reached here,
          // because result is set first by the soft timeout), keep the fallback copy consistent.
          setResult(t('importSkill.result.session.accepted'));
        }
        setTimeout(() => props.onImported(), 1500);
        return;
      }

      // ==== Directory import: use v3 create + files/write ====
      if (!partition?.mainFile) {
        throw new Error(partition?.warning ?? t('importSkill.error.noMainFile'));
      }
      const content = await readAsUtf8(partition.mainFile);
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      const nameMatch = fmMatch?.[1].match(/^name:\s*(.+)$/m);
      const name = nameMatch?.[1].trim().replace(/^["']|["']$/g, '') || partition.skillName || '';
      if (!name) {
        throw new Error(t('importSkill.error.noName'));
      }
      const resourceFiles: { path: string; file: File; isBinary: boolean }[] = partition.resources.map(
        ({ path, file }) => ({ path, file, isBinary: !looksLikeText(file) }),
      );

      // Ensure content starts with `---\n` (v3 frontmatter format requirement).
      const safeContent = content.trimStart().startsWith('---') ? content : `---\nname: ${name}\n---\n\n${content}`;

      // Resource files are persisted to the database in one go with create (single version v1).
      // Fix: the original implementation was create(resources=[] → v1) + files/write(→ v2) in two steps,
      // which caused any imported skill with resources to be stored as v2 upon persistence (version semantics messed up).
      // v3 create itself supports the resources array, so merging it into a single call ensures that a newly created skill = v1.
      const resources: SkillResourcePayload[] = resourceFiles.length > 0
        ? await Promise.all(
            resourceFiles.map(async ({ path, file, isBinary }) =>
              isBinary
                ? { path, content: await readAsBase64(file), encoding: 'base64' as const }
                : { path, content: await readAsUtf8(file), encoding: 'utf-8' as const },
            ),
          )
        : [];

      await createSkill({
        user_id: props.userId,
        team_id: props.teamId,
        agent_id: agentId || props.userId, // v3 requires agent_id, fixed pattern uses the selected one, otherwise uses userId as fallback
        name,
        content: safeContent,
        resources: resources.length ? resources : undefined,
      });

      setResult(t('importSkill.result.directory', { name, count: resourceFiles.length }));
      setTimeout(() => props.onImported(), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Whether to show the "Belonging Agent" selector in the popup:
  //   - Only fixed-target has the concept of agent belonging
  //   - The dropdown must be rendered only when agents are passed
  const showAgentPicker = props.target === 'fixed' && !!props.agents;

  return (
    <Modal visible caption={t('importSkill.caption')} size="l" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Alert type="info">{t('importSkill.hint')}</Alert>
      {/* Belongs to Agent —— Required. Always displayed above the import method,
          Consistent with ChatMemoryPanel.ImportBlockDialog: even if agentId is passed from the outer layer
          Also allows re-selection in the popup. */}
      {showAgentPicker && (
        <Form layout="vertical" style={{ width: '100%' }}>
          <Form.Item
            label={t('importSkill.agent')}
            extra={t('importSkill.agent.extra')}
          >
            {props.agents!.length === 0 ? (
              <Alert type="warning">{t('importSkill.agent.noAgent')}</Alert>
            ) : (
              <Select
                size="full"
                value={selectedAgentId}
                onChange={setSelectedAgentId}
                placeholder={t('importSkill.agent.placeholder')}
                options={props.agents!.map((a) => ({ value: a.id, text: `${a.name}（${a.id}）` }))}
              />
            )}
          </Form.Item>
        </Form>
      )}

      {/* Mode tabs: only keep directory (directory import) / session (session import) */}
      <Segment
        className="_memory-isd-mode-segment"
        value={mode}
        onChange={(v) => setMode(v as Mode)}
        options={[
          { value: 'directory', text: t('importSkill.mode.directory') },
          { value: 'session', text: t('importSkill.mode.session') },
        ]}
      />

      {mode === 'directory' && (
        <div className="_memory-isd-section">
          <div className="_memory-isd-label">{t('importSkill.directory.label')}</div>
          {/*
            The directory selection has no Tea component equivalent, so the native input is retained here as the sole exemption, hidden after the following
            Tea Button triggers click. webkitdirectory/directory are non-standard but widely supported browsers
            Attributes, React type definitions not included, pass through with spread + any instead of @ts-expect-error per attribute.
          */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => {
              const list = e.target.files;
              if (!list) return;
              setPickedFiles(Array.from(list));
            }}
            className="_memory-isd-hidden-file-input"
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          />
          <Button onClick={() => fileInputRef.current?.click()}>
            <FolderOpenIcon size={14} /> {t('importSkill.directory.selectFile')}
          </Button>
          {pickedFiles.length > 0 && (
            <span className="_memory-isd-picked-count">{t('importSkill.directory.picked', { count: pickedFiles.length })}</span>
          )}
          {pickedFiles.length > 0 && partition && (
            <div className="_memory-isd-partition-box">
              <div>
                {t('importSkill.directory.mainFile')}
                {partition.mainFile ? (
                  <span className="_memory-isd-main-file">
                    {partition.mainFile.webkitRelativePath || partition.mainFile.name}
                  </span>
                ) : (
                  <span className="_memory-isd-error-text">{t('importSkill.directory.noSkillMd')}</span>
                )}
              </div>
              <div>{t('importSkill.directory.resources', { count: partition.resources.length })}</div>
              {partition.resources.length > 0 && (
                <ul className="_memory-isd-resource-list">
                  {partition.resources.map((r) => (
                    <li key={r.path}>· {r.path} ({Math.round(r.file.size / 1024)}KB)</li>
                  ))}
                </ul>
              )}
              {partition.warning && (
                <div className="_memory-isd-warning-text">{partition.warning}</div>
              )}
            </div>
          )}
        </div>
      )}

      {mode === 'session' && (
        <div className="_memory-isd-section">
          <Alert type="info">
            {t('importSkill.session.hintPrefix')}
            <span className="_memory-isd-mono-inline">messages</span>
            {t('importSkill.session.hintSuffix')}
          </Alert>
          <Form layout="vertical" style={{ width: '100%' }}>
            <Form.Item label={t('importSkill.session.label')}>
              <Input.TextArea
                size="full"
                value={sessionPayload}
                onChange={setSessionPayload}
                rows={16}
                placeholder={JSON.stringify(
                  {
                    session_id: 'demo-user-extract-demo-1',
                    task_id: 'default',
                    messages: [
                      { role: 'user', content: t('importSkill.sample.user') },
                      { role: 'assistant', content: t('importSkill.sample.assistant') },
                      { role: 'tool_call', content: t('importSkill.sample.toolCall') },
                      { role: 'tool_result', content: t('importSkill.sample.toolResult') },
                      { role: 'assistant', content: t('importSkill.sample.assistant2') },
                    ],
                  },
                  null,
                  2,
                )}
                className="_memory-isd-mono-input"
              />
            </Form.Item>
          </Form>
        </div>
      )}

      {error && <Alert type="error">{error}</Alert>}
      {result && <Alert type="success"><span className="_memory-isd-result-text">{result}</span></Alert>}
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          onClick={() => void submit()}
          disabled={
            submitting
            || (mode === 'directory' ? !partition?.mainFile : !sessionPayload.trim())
            || (props.target === 'fixed' && !selectedAgentId)
          }
          title={props.target === 'fixed' && !selectedAgentId ? t('importSkill.error.noAgentHint') : ''}
          loading={submitting}
        >
          {mode === 'session' ? t('importSkill.session.submit') : t('importSkill.submit')}
        </Button>
        <Button onClick={props.onClose} disabled={submitting}>{t('importSkill.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
