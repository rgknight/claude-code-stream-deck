import { mkdir, rename, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

import { redactSecrets } from "./status.js";

export type LogLevel = "error" | "warn" | "info" | "debug";

export class DiagnosticLogger {
  readonly #file: string;
  readonly #debugEnabled: () => boolean;
  #queue: Promise<void> = Promise.resolve();

  constructor(directory: string, debugEnabled: () => boolean) {
    this.#file = path.join(directory, "claude-streamdeck.log");
    this.#debugEnabled = debugEnabled;
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.#write("error", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.#write("warn", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.#write("info", message, fields);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    if (this.#debugEnabled()) this.#write("debug", message, fields);
  }

  #write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    const safeFields = fields ? JSON.stringify(fields, (_key, value) => (typeof value === "string" ? redactSecrets(value) : value)) : "";
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redactSecrets(message).slice(0, 800)}${safeFields ? ` ${safeFields.slice(0, 1600)}` : ""}\n`;
    this.#queue = this.#queue.then(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true });
      await this.#rotate();
      await appendFile(this.#file, line, { encoding: "utf8", mode: 0o600 });
    }).catch(() => undefined);
  }

  async #rotate(): Promise<void> {
    try {
      if ((await stat(this.#file)).size < 1_048_576) return;
      const backup = `${this.#file}.1`;
      await rename(this.#file, backup).catch(async () => writeFile(this.#file, "", "utf8"));
    } catch {
      // A missing log file is the normal first-run case.
    }
  }
}
