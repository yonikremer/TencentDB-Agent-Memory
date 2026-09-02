/**
 * tokenize.ts — 中英文混合分词器（BM25/FTS5 共用）。
 *
 * 从 manager.ts 抽出为独立 leaf 模块：manager 与 ingest-v2/retrieval.ts 都需要它，
 * 独立放置避免静态 import 环（manager 已动态 import ingest-v2/index.js）。
 *
 * - 英文：按空格/标点切分，保留完整单词，过滤 stop words
 * - 中文：bigram + 单字
 *
 * 导出供 FTS5 预分词复用（006）与 bm25 评测：写入 FTS5 时把 content/title
 * 经此函数分词后以空格拼接存入，查询时对 query 用同一分词，保证中文逻辑一致。
 */

const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
]);

export function tokenize(text: string): string[] {
  const rawTokens = text
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…\[\]【】{}《》<>]+/)
    .filter((t) => t.length > 0);

  const result: string[] = [];
  for (const token of rawTokens) {
    const hasCJK = /[一-鿿㐀-䶿]/.test(token);
    const hasLatin = /[a-z]/.test(token);

    if (hasCJK && hasLatin) {
      // 混合 token（如 "l0录入"）：拆分中英文部分分别处理
      const parts = token.split(/(?<=[a-z0-9])(?=[一-鿿])|(?<=[一-鿿])(?=[a-z0-9])/);
      for (const part of parts) {
        if (/[一-鿿]/.test(part) && part.length > 1) {
          const chars = [...part];
          for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
          result.push(part);
        } else if (part.length > 0 && !STOP_WORDS.has(part)) {
          result.push(part);
        }
      }
    } else if (hasCJK && token.length > 1) {
      // 纯中文：bigram
      const chars = [...token];
      for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
      result.push(token);
    } else if (!STOP_WORDS.has(token) && token.length > 0) {
      // 纯英文/数字：保留完整 token
      result.push(token);
    }
  }
  return result;
}
