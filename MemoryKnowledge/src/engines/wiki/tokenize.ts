/**
 * tokenize.ts — Mixed Chinese/English tokenizer (shared by BM25/FTS5).
 *
 * Extracted from manager.ts as an independent leaf module: both manager and ingest-v2/retrieval.ts need it.
 * Placed independently to avoid static import cycles (manager dynamically imports ingest-v2/index.js).
 *
 * - English: split by spaces/punctuation, preserve full words, filter stop words
 * - Chinese: bigram + single characters
 *
 * Exported for FTS5 pre-tokenization reuse (006) and BM25 evaluation: when writing to FTS5, content/title
 * are tokenized via this function, joined with spaces, and stored; during queries, the same tokenizer is applied to query, ensuring consistent Chinese logic.
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
      // Mixed token (e.g. "l0ingest"): split Chinese and English parts and process separately
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
      // Pure Chinese: bigram
      const chars = [...token];
      for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
      result.push(token);
    } else if (!STOP_WORDS.has(token) && token.length > 0) {
      // Pure English/digits: preserve full token
      result.push(token);
    }
  }
  return result;
}
