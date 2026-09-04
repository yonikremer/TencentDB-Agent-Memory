/**
 * source-fetcher barrel — Export entry point for source code fetching interface layer.
 */

export type { ISourceFetcher, FetchResult, SourceType } from "./types.js";
export { GitSourceFetcher, type GitSourceFetcherOptions } from "./git-fetcher.js";
export { SourceFetcherRegistry } from "./registry.js";
