/**
 * retrieval.ts — 检索增强摄取（retrieval-augmented ingestion）的纯函数辅助。
 *
 * 用途：把一个待摄取源文档转成搜索 query，并把检索到的既有 wiki 页正文
 * 格式化为可注入提取 prompt 的上下文块——让依赖先前文档的源（"assumes you've
 * read the first 20"）在提取时真正拿到先前知识，而不只是逐页元数据清单。
 *
 * 本模块只含纯函数，不碰 SQLite / LLM，便于单测。真正的检索编排（searchInternal
 * + readPage）在 manager.ts 的 ingest() 内闭包完成，这里负责 query 构造与格式化。
 */

import { tokenize } from "../tokenize.js";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * 把源文档转成搜索 query 串。
 *
 * 对源文本分词（中英文混合、过滤 stop words），按词频降序取前 queryTerms 个
 * 高频词，用空格拼接。ftsSearch 会再次 tokenize 并做 `"term"* OR ...` 扩展，
 * 因此这里产出的是 token 序列，round-trip 语义一致。
 *
 * 按词频选取（而非顺序前 N）能避开长文档开头的大段啰嗦词，命中更聚焦。
 */
export function buildSearchQuery(sourceText: string, queryTerms: number): string {
  const n = Math.max(1, Math.floor(queryTerms));
  const counts = new Map<string, number>();
  for (const term of tokenize(sourceText)) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  // Map 保持插入序；Array.prototype.sort 稳定（ES2019+），词频并列时按首次出现顺序。
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked
    .slice(0, n)
    .map(([term]) => term)
    .join(" ");
}

export interface RetrievedPage {
  relPath: string;
  title: string;
  content: string;
}

/**
 * 把检索到的页正文格式化为注入 prompt 的上下文块。
 *
 * - 每页去掉 frontmatter，只保留正文。
 * - 输出总长受 maxChars 限制（含块头）；预算不足以放下一个完整块时，
 *   尝试截断补块，仍不足则停止。
 * - pages 为空返回 ""（无增强，等价于关闭该特性）。
 */
export function formatRetrievedPages(pages: RetrievedPage[], maxChars: number): string {
  if (pages.length === 0) return "";
  const budget = Math.max(1000, Math.floor(maxChars));
  const header = "## Relevant Existing Knowledge (previously ingested pages — treat as established facts)";
  const sep = "\n\n";
  const blocks: string[] = [];
  let used = header.length;
  for (const p of pages) {
    const { frontmatter, body } = parseFrontmatter(p.content);
    const title = p.title || (typeof frontmatter.title === "string" ? frontmatter.title : "") || p.relPath;
    const block = `### ${title} (${p.relPath})\n${body.trim()}`;
    const cost = block.length + sep.length;
    if (used + cost > budget) {
      const remaining = budget - used - sep.length;
      if (remaining > 40) blocks.push(`${block.slice(0, remaining).trimEnd()}…`);
      break;
    }
    blocks.push(block);
    used += cost;
  }
  if (blocks.length === 0) return "";
  return `${header}${sep}${blocks.join(sep)}`;
}
