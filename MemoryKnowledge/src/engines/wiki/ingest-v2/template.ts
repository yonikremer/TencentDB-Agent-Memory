/**
 * template.ts — Reads wiki/schema.md and wiki/purpose.md as extraction templates (FR-4b).
 *
 * These two files allow users/callers to customize "what this wiki wants to extract and how to organize it":
 *   - purpose.md: declares the target domain and purpose of the wiki.
 *   - schema.md: declares extraction preferences (desired page types, key fields, naming/language conventions).
 *
 * During ingest, they are concatenated into system prompt as-is (no forced machine parsing of skeleton for fault tolerance).
 * When empty/non-existent, falls back to domain-neutral default skeleton, ensuring out-of-the-box functionality.
 *
 * Note: Default files initialized by init (manager.initWikiProject) may just be empty shells
 * (such as only `# Wiki Schema\n\nDefine ... here.`), which are treated as "no effective content" and use defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export interface WikiTemplate {
  /** Effective body of purpose.md (frontmatter stripped), default if absent. */
  purpose: string;
  /** Effective body of schema.md (frontmatter stripped), default if absent. */
  schema: string;
  /** Whether user-customized content was used (for logging/debugging). */
  customized: boolean;
}

/** Default purpose — software engineering knowledge base. */
export const DEFAULT_PURPOSE = `This knowledge base accumulates and organizes engineering knowledge of software systems,
including system architecture, module design, data flow, deployment models, permission models, etc.
By ingesting requirement documents, architecture designs, meeting notes, RFCs, technical decisions and other
source documents, it builds a structured, cross-referenced knowledge graph to help team members quickly
understand the system landscape and the rationale behind design decisions.`;

/** Default schema skeleton — software engineering knowledge base. */
export const DEFAULT_SCHEMA = `# Page types
- entity — a concrete component or role in the system; must declare a kind field
- concept — an abstract design idea (system architecture, module boundaries, data flow, deployment model, permission model, evaluation framework, etc.)
- source — one summary page per ingested source document; must declare a source_type field
Other types (comparison, synthesis, etc.) may be created as needed.

# Fields / sections per type
- entity:
    - kind: module | service | platform | external_system | user_role | other (required)
    - definition: responsibility / purpose
    - key attributes: key properties
    - relationships: relationships to other entities
- concept:
    - definition: concept definition
    - significance: importance / role
    - related entities: associated entities
    - common topics: system architecture, module boundaries, data flow, deployment model, permission model, evaluation framework
- source:
    - source_type: requirement | architecture | meeting | rfc | decision | other (required)
    - source document summary
- Use OKF sections where applicable: # Schema / # Examples / # Citations

# Naming & language
- slug: lowercase, spaces→hyphens
- Output language: follow the source document — do not switch`;

/** Determines whether body text has "meaningful content" (excluding empty shell placeholders created by init). */
function hasMeaningfulContent(body: string): boolean {
  const stripped = body
    .replace(/^#.*$/gm, "")              // Remove heading lines
    .replace(/Define\b[^.。]*[.。]?/gi, "") // Remove "Define ..." placeholder sentence (init default shell)
    .replace(/\s+/g, "");
  return stripped.length >= 8;
}

function readTemplateFile(projectPath: string, name: string): string | null {
  const full = join(projectPath, "wiki", name);
  if (!existsSync(full)) return null;
  try {
    const content = readFileSync(full, "utf-8");
    const { body } = parseFrontmatter(content);
    const trimmed = body.trim();
    if (!trimmed || !hasMeaningfulContent(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Loads extraction template. Uses user content if present and meaningful; otherwise falls back to domain-neutral defaults.
 */
export function loadTemplate(projectPath: string): WikiTemplate {
  const purpose = readTemplateFile(projectPath, "purpose.md");
  const schema = readTemplateFile(projectPath, "schema.md");
  return {
    purpose: purpose ?? DEFAULT_PURPOSE,
    schema: schema ?? DEFAULT_SCHEMA,
    customized: purpose != null || schema != null,
  };
}
