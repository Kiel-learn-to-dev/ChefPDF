/**
 * Size-based rotating log file (core.log, core.log.1, ... core.log.N).
 * Synchronous appends: volumes are small and this keeps ordering trivially correct.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface RotatingLogOptions {
  maxBytes?: number;
  maxFiles?: number;
}

export class RotatingLog {
  private size = -1;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(
    readonly file: string,
    options: RotatingLogOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = Math.max(1, options.maxFiles ?? 3);
  }

  write(data: string | Buffer): void {
    try {
      if (this.size < 0) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      }
      const len = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      if (this.size > 0 && this.size + len > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, data);
      this.size += len;
    } catch {
      // Logging must never take the app down.
    }
  }

  /** Writes one timestamped line (for messages originating in main). */
  line(message: string): void {
    this.write(`[${new Date().toISOString()}] ${message}\n`);
  }

  private rotate(): void {
    fs.rmSync(`${this.file}.${this.maxFiles}`, { force: true });
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
    }
    fs.renameSync(this.file, `${this.file}.1`);
    this.size = 0;
  }
}
