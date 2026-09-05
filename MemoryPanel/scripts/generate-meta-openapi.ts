/**
 * Generate new stateless panel (A) link OpenAPI 3.0.
 * Run: pnpm generate:meta-openapi
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  META_ACTIONS,
  META_LIST_ACTIONS,
  isNotInScopeAction,
} from '../src/panel/api/meta-actions.js';

const OUT = join(process.cwd(), 'docs/api/meta-api.openapi.yaml');

const ACTION_TAG: Record<string, string> = {
  user: 'Meta · User',
  'user-key': 'Meta · User Key',
  team: 'Meta · Team',
  'team-member': 'Meta · Team Member',
  agent: 'Meta · Agent',
  task: 'Meta · Task',
  'task-agent': 'Meta · Task Agent',
  asset: 'Meta · Asset',
  'agent-fixed-asset': 'Meta · Agent Fixed Asset',
  acl: 'Meta · ACL',
  auth: 'Meta · Auth',
};

const AUTH_VERIFY = 'auth/verify';

function tagFor(action: string): string {
  const prefix = action.includes('/') ? action.slice(0, action.indexOf('/')) : action;
  if (action.startsWith('team-member')) return ACTION_TAG['team-member'] ?? 'Meta';
  if (action.startsWith('user-key')) return ACTION_TAG['user-key'] ?? 'Meta';
  if (action.startsWith('task-agent')) return ACTION_TAG['task-agent'] ?? 'Meta';
  if (action.startsWith('agent-fixed-asset')) return ACTION_TAG['agent-fixed-asset'] ?? 'Meta';
  return ACTION_TAG[prefix] ?? 'Meta';
}

function yamlQuote(s: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function panelDescription(action: string): string {
  if (isNotInScopeAction(action)) {
    return 'New Panel Phase 1 **is not forwarded** to the kernel; Control returns HTTP 501, `message=NOT_IN_SCOPE`.';
  }
  if (action === AUTH_VERIFY) {
    return 'Login verification: Header only `X-Tdai-Service-Id`; body must contain `user_key`. Check `data.valid` for success (soft validation).';
  }
  if (action === 'user/list') {
    return 'Transparent proxy; team_id can be omitted for system_admin only (instance-level list). Optional user_ids, username (exact match) filtering. Response UserPublic includes username.';
  }
  if (action === 'team-member/list') {
    return 'paginated list; body must be team_id. Response items are TeamMemberEntity (including username from read-time JOIN, v3.2.2+); only active team members can call. Default joined_at DESC. Requires dual credentials in Header.';
  }
  if (action === 'team-member/get') {
    return 'Transparent proxy; response TeamMemberEntity includes username (v3.2.2+, JOIN on read). Must be a team active member. Must have dual credentials in Header.';
  }
  if (action === 'team-member/add') {
    return 'Transparent proxy; team admin. Prohibit self add, prohibit demote owner. Response TeamMemberEntity **excludes** username (v3.2.2+); after adding, obtain display name via team-member/list. v3.2.3+: active same as role duplicate add → 409 member_already_exists.';
  }
  if (action === 'team-member/remove') {
    return 'Transparent proxy; team admin. Prohibit removing team owner (403 cannot remove team owner). Physically delete member row. Requires dual credentials from Header.';
  }
  if (action === 'team/update') {
    return 'Transparent proxy; team owner or admin. Cannot change owner_user_id (silently ignored if passed). See 08-metadata-v3-api-reference.md. Requires dual credentials in Header.';
  }
  if (action === 'agent/update') {
    return 'Transparent proxy; agent owner. Cannot modify owner_user_id (silently ignored if passed). See 08-metadata-v3-api-reference.md. Requires dual credentials in Header.';
  }
  if (action === 'user/create' || action === 'user/delete') {
    return 'Transparent proxy; Header `X-Tdai-User-Key` must be system_admin. Non admin → kernel 403.';
  }
  if (META_LIST_ACTIONS.has(action)) {
    return 'paginated list; body optional limit (default 20, max 100), offset (default 0). Default created_at DESC (v3.1.2+; team-member is joined_at DESC). Requires dual credentials in Header.';
  }
  return 'Transparent proxy to kernel; fields see 08-metadata-v3-api-reference.md. Requires dual credentials in Header.';
}

function buildMetaPostPath(action: string): string {
  const lines: string[] = [];
  lines.push(`  /api/v1/meta/${action}:`);
  lines.push('    post:');
  lines.push(`      tags: [${yamlQuote(tagFor(action))}]`);
  lines.push(`      operationId: meta_${action.replace(/\//g, '_')}`);
  lines.push(`      summary: ${action}`);
  lines.push(`      description: ${yamlQuote(panelDescription(action))}`);
  lines.push('      security: []');
  lines.push('      parameters:');
  lines.push("        - $ref: '#/components/parameters/TdaiServiceId'");
  if (action !== AUTH_VERIFY) {
    lines.push("        - $ref: '#/components/parameters/TdaiUserKey'");
  }
  lines.push('      requestBody:');
  lines.push('        required: true');
  lines.push('        content:');
  lines.push('          application/json:');
  lines.push('            schema:');
  lines.push('              type: object');
  lines.push('              additionalProperties: true');
  lines.push('      responses:');
  lines.push("        '200':");
  lines.push('          description:  Kernel style envelope (business success or failure prioritizes body.code)');
  lines.push('          content:');
  lines.push('            application/json:');
  lines.push('              schema:');
  lines.push("                $ref: '#/components/schemas/ApiResponse'");
  if (isNotInScopeAction(action)) {
    lines.push("        '501':");
    lines.push('          $ref: "#/components/responses/NotInScope"');
  }
  lines.push("        '400':");
  lines.push('          $ref: "#/components/responses/ControlBadRequest"');
  lines.push("        '502':");
  lines.push('          $ref: "#/components/responses/KernelUnavailable"');
  lines.push("        '504':");
  lines.push('          $ref: "#/components/responses/KernelTimeout"');
  return lines.join('\n');
}

const header = `openapi: 3.0.3
info:
  title: Team Memory Control — New Panel Metadata API (stateless)
  description: |
    New Panel Control **Stateless Proxy**: `/api/v1/meta/*` transparently forwards memory kernel `/v3/meta/*` (v3.1).

    **Authentication (Header, no cookie)**
    - \`X-Tdai-Service-Id\`: Instance ID (from \`GET /meta/instances\`, = kernel \`x-tdai-service-id\`)
    - \`X-Tdai-User-Key\`: User key \`sk-mem-…\` (except \`auth/verify\`, user_key only in body)

    **Response Envelope** \`{ code, message, request_id, data }\`
    - \`code === 0\` → HTTP **200** (request execution successful)
    - \`code ∈ [400, 599]\` → HTTP equal to code **
    - Soft validation: \`auth/verify\` checks \`data.valid\`; \`acl/check\` checks \`data.allowed\`

    Design document: [09-new-panel-control-backend-design.md](../architecture/09-new-panel-control-backend-design.md)
    Kernel field authority: [08-metadata-v3-api-reference.md](../architecture/08-metadata-v3-api-reference.md)
  version: 1.3.1
  contact:
    name: team-memory-control

servers:
  - url: http://127.0.0.1:8123
    description: Local Control (`PANEL_MODE=stateless` or `pnpm dev:panel`)
  - url: https://{controlHost}
    description: Deployment environment
    variables:
      controlHost:
        default: control.example.com

tags:
  - name: Meta · Control
    description: Control auxiliary interface
  - name: Meta · User
  - name: Meta · User Key
  - name: Meta · Team
  - name: Meta · Team Member
  - name: Meta · Agent
  - name: Meta · Task
  - name: Meta · Task Agent
  - name: Meta · Asset
  - name: Meta · Agent Fixed Asset
  - name: Meta · ACL
  - name: Meta · Auth

paths:
  /api/v1/meta/instances:
    get:
      tags: [Meta · Control]
      operationId: meta_instances_list
      summary: List of memory instances (before login)
      description: |
        Return all memory instances from the configuration file, **no pagination**.
        Only publicly expose \`instance_id\`, \`name\` (excluding gateway_endpoint / api_key).
        Configuration: \`METADATA_INSTANCES_CONFIG\` (default \`./config/metadata-instances.json\`).
      security: []
      responses:
        '200':
          description: Public instance list
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/MetadataInstanceListResponse'
              example:
                instances:
                  - instance_id: default
                    name: Community R&D Demo Instance
                  - instance_id: sre-platform
                    name: SRE Platform Instance
`;

const metaPaths = META_ACTIONS.map(buildMetaPostPath).join('\n');

const components = `
components:
  parameters:
    TdaiServiceId:
      name: X-Tdai-Service-Id
      in: header
      required: true
      schema:
        type: string
      description: Memory instance ID (= registry id = kernel x-tdai-service-id)
      example: default
    TdaiUserKey:
      name: X-Tdai-User-Key
      in: header
      required: true
      schema:
        type: string
      description: User API key sk-mem-… (auth/verify does not use this Header)
      example: sk-mem-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

  responses:
    ControlBadRequest:
      description: Control validation error (kernel not forwarded)
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 400
            message: INVALID_INSTANCE
            request_id: req-example
            data: null
    NotInScope:
      description: disabled action domain (asset / agent-fixed-asset) for new panel phase 1
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 501
            message: NOT_IN_SCOPE
            request_id: req-example
            data: null
    KernelUnavailable:
      description: kernel unreachable
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 502
            message: KERNEL_UNAVAILABLE
            request_id: req-example
            data: null
    KernelTimeout:
      description: kernel timeout
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ApiResponse'
          example:
            code: 504
            message: KERNEL_TIMEOUT
            request_id: req-example
            data: null

  schemas:
    PublicMetadataInstance:
      type: object
      required: [instance_id, name]
      properties:
        instance_id:
          type: string
          description: Memory instance ID (corresponding to kernel x-tdai-service-id)
          example: default
        name:
          type: string
          description: Display name on login page
          example: Community R&D demo instance

    MetadataInstanceListResponse:
      type: object
      required: [instances]
      properties:
        instances:
          type: array
          items:
            $ref: '#/components/schemas/PublicMetadataInstance'

    ApiResponse:
      type: object
      required: [code, message, request_id, data]
      properties:
        code:
          type: integer
          description: |
            0 = request execution successful.
            400–599 when the HTTP status code equals code.
            Prioritize checking code for business success; check data.valid / data.allowed for soft validation.
          example: 0
        message:
          type: string
          example: ok
        request_id:
          type: string
          example: req-a1b2c3d4
        data:
          nullable: true
          description: Success payload; failure is usually null

    PaginatedResult:
      type: object
      required: [items, total, limit, offset]
      properties:
        items:
          type: array
          items:
            type: object
            additionalProperties: true
        total:
          type: integer
        limit:
          type: integer
          minimum: 1
          maximum: 100
        offset:
          type: integer
          minimum: 0

    PaginationInput:
      type: object
      properties:
        limit:
          type: integer
          minimum: 1
          maximum: 100
          default: 20
        offset:
          type: integer
          minimum: 0
          default: 0
`;

const yaml = [header, metaPaths, components].join('\n');
writeFileSync(OUT, yaml, 'utf8');
console.log(`Wrote ${OUT} (${META_ACTIONS.length} POST actions + GET instances)`);
