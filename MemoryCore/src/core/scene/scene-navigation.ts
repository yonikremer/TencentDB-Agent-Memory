/**
 * Scene navigation: generates a summary navigation section appended to persona.md.
 *
 * The navigation includes **absolute** file paths so the agent can directly
 * use read_file for on-demand scene loading (progressive disclosure).
 */

import path from "node:path";
import type { SceneIndexEntry } from "./scene-index.js";

const NAV_HEADER = "---\n## 🗺️ Scene Navigation (Scene Index)";

const NAV_FOOTER_LOCAL = `📌 Usage notes:
- Path is the absolute path to a scene block; use the **read** tool to read its full content (parameter: filePath)
- Heat: cumulative number of times this scene was matched by memories — higher means more important
- Summary: core highlights/summary of the scene`;

const NAV_FOOTER_COS = `📌 Usage notes:
- Path is the storage path of the scene block; use the **tdai_read_cos** tool to read its full content (parameter: path)
- Heat: cumulative number of times this scene was matched by memories — higher means more important
- Summary: core highlights/summary of the scene`;

/**
 * Build a fire-emoji string based on heat value (visual priority cue for the agent).
 */
function heatEmoji(heat: number): string {
  if (heat >= 1000) return " 🔥🔥🔥🔥🔥";
  if (heat >= 500) return " 🔥🔥🔥🔥";
  if (heat >= 200) return " 🔥🔥🔥";
  if (heat >= 100) return " 🔥🔥";
  if (heat >= 50) return " 🔥";
  return "";
}

/**
 * Generate the scene navigation Markdown section.
 *
 * @param entries - Scene index entries
 * @param dataDir - Absolute path to the plugin data directory; when provided
 *                  and useCos=false, paths are absolute for read_file.
 * @param useCos  - When true, paths use scenes/ prefix and footer says tdai_read_cos.
 */
export function generateSceneNavigation(entries: SceneIndexEntry[], dataDir?: string, useCos = false): string {
  if (entries.length === 0) return "";

  const sorted = [...entries].sort((a, b) => b.heat - a.heat);

  const blocks = sorted.map((e) => {
    let scenePath: string;
    if (useCos) {
      scenePath = `scenes/${e.filename}`;
    } else {
      scenePath = dataDir
        ? path.join(dataDir, "scene_blocks", e.filename)
        : `scene_blocks/${e.filename}`;
    }
    const pathLine = `### Path: ${scenePath}`;
    const heatLine = `**Heat**: ${e.heat}${heatEmoji(e.heat)}${e.updated ? ` | **Updated**: ${e.updated}` : ""}`;
    const summaryLine = `Summary: ${e.summary}`;
    return `${pathLine}\n${heatLine}\n${summaryLine}`;
  });

  const toolHint = useCos ? "tdai_read_cos" : "read";
  const footer = useCos ? NAV_FOOTER_COS : NAV_FOOTER_LOCAL;

  return `${NAV_HEADER}\n*Below is an index of the current scene memories. Use ${toolHint} to read details as needed.*\n\n${blocks.join("\n\n")}\n\n${footer}`;
}

/**
 * Strip the scene navigation section from persona content.
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf(NAV_HEADER);
  if (idx === -1) return personaContent;
  return personaContent.slice(0, idx).trimEnd();
}
