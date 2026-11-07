/**
 * Splits a stream of arbitrary chunks into complete newline-delimited lines.
 *
 * The Claude (`claude -p` stream-json), Codex (`codex exec --json`), and Grok
 * (`grok -p --output-format streaming-json`) CLIs speak newline-delimited JSON
 * on stdout, but a single `data` event can
 * carry a partial line or several lines at once. This buffers across chunks and
 * emits one trimmed, non-empty line at a time.
 */
export class LineReader {
  private buffer = "";

  /** Feed a raw chunk; returns the complete lines it produced (without the newline). */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) lines.push(line);
      index = this.buffer.indexOf("\n");
    }
    return lines;
  }

  /** Returns any buffered trailing content (no newline seen) and clears it. */
  flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = "";
    return remaining || null;
  }
}
