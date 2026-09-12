declare module "word-extractor" {
  export interface WordDocument {
    getBody(): string;
  }
  export default class WordExtractor {
    extract(buf: Buffer | Uint8Array): Promise<WordDocument>;
  }
}
