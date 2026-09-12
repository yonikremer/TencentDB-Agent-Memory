declare module "@kenjiuno/msgreader" {
  export interface MsgFileData {
    subject?: string;
    senderName?: string;
    senderEmail?: string;
    body?: string;
    attachments?: Array<{ fileName?: string; name?: string }>;
    [key: string]: unknown;
  }
  export default class MsgReader {
    constructor(buf: Buffer | Uint8Array);
    getFileData(): MsgFileData;
  }
}
