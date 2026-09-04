/**
 * Metadata API trace → stdout single-line JSON (CLS reuse).
 */
export const API_TRACE_INTERFACE = "tdai-metadata-api";

type StdoutWriter = (line: string) => void;

let stdoutWriter: StdoutWriter = (line) => {
  process.stdout.write(line);
};

export function buildStdoutPayload(
  level: string,
  event: string,
  profile: string,
  merged: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return {
    interface: API_TRACE_INTERFACE,
    time: new Date().toISOString(),
    level: level.toUpperCase(),
    msg: event,
    profile,
    ...merged,
  };
}

export function writeApiTraceStdout(payload: Record<string, unknown>): void {
  try {
    const line = `${JSON.stringify(payload)}\n`;
    stdoutWriter(line);
  } catch {
    // Fail silently
  }
}

/** For testing: replace stdout writer. */
export function setStdoutWriterForTests(writer: StdoutWriter | null): void {
  stdoutWriter = writer ?? ((line) => process.stdout.write(line));
}

/** For testing: read current stdout writer. */
export function getStdoutWriterForTests(): StdoutWriter {
  return stdoutWriter;
}
