/**
 * SourceFetcherRegistry — Routes to the corresponding ISourceFetcher by sourceUrl protocol.
 *
 * Workers in module.ts obtain fetchers via registry.resolve(url) instead of invoking git directly.
 * Adding new protocols in the future only requires implements ISourceFetcher + register().
 */

import type { ISourceFetcher, SourceType } from "./types.js";
import { GitSourceFetcher } from "./git-fetcher.js";

export class SourceFetcherRegistry {
  private readonly fetchers = new Map<SourceType, ISourceFetcher>();

  constructor() {
    this.register(new GitSourceFetcher());
    // Future: this.register(new LocalSourceFetcher());
    // Future: this.register(new FtpSourceFetcher());
  }

  register(fetcher: ISourceFetcher): void {
    this.fetchers.set(fetcher.supportedType, fetcher);
  }

  /** Auto-detects protocol type from sourceUrl and returns corresponding fetcher; throws if unregistered. */
  resolve(sourceUrl: string): ISourceFetcher {
    const type = this.detectType(sourceUrl);
    const fetcher = this.fetchers.get(type);
    if (!fetcher) {
      throw new Error(`unsupported source type: ${type} (${sourceUrl})`);
    }
    return fetcher;
  }

  private detectType(url: string): SourceType {
    if (
      url.startsWith("git@") ||
      url.startsWith("ssh://") ||
      url.startsWith("https://") ||
      url.startsWith("http://")
    ) {
      return "git";
    }
    if (url.startsWith("file://") || url.startsWith("/") || url.startsWith("./")) {
      return "local";
    }
    if (url.startsWith("ftp://")) return "ftp";
    return "git";
  }
}
