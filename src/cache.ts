import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CacheFile } from "./domain.js";
import type { DiagnosticLogger } from "./logger.js";

const EMPTY_CACHE: CacheFile = {
  schemaVersion: 2,
  sessions: {},
  projects: [],
  slots: {}
};
const MAX_CACHE_BYTES = 10 * 1024 * 1024;

function isCache(value: unknown): value is CacheFile {
  if (!value || typeof value !== "object") return false;
  const object = value as Partial<CacheFile>;
  return (
    object.schemaVersion === 2 &&
    !!object.sessions &&
    typeof object.sessions === "object" &&
    Array.isArray(object.projects) &&
    !!object.slots &&
    typeof object.slots === "object"
  );
}

export class CacheStore {
  readonly #file: string;
  readonly #backup: string;
  readonly #logger: DiagnosticLogger;

  constructor(directory: string, logger: DiagnosticLogger) {
    this.#file = path.join(directory, "cache-v2.json");
    this.#backup = path.join(directory, "cache-v2.last-good.json");
    this.#logger = logger;
  }

  async load(): Promise<CacheFile> {
    const primary = await this.#read(this.#file);
    if (primary) return primary;
    const backup = await this.#read(this.#backup);
    if (backup) {
      this.#logger.warn("Restored cache from last-known-good copy");
      return backup;
    }
    return structuredClone(EMPTY_CACHE);
  }

  async save(cache: CacheFile): Promise<void> {
    const serialized = JSON.stringify(cache);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CACHE_BYTES) throw new Error("Cache exceeds 10 MiB limit");
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await stat(this.#file);
      await unlink(this.#backup).catch(() => undefined);
      await rename(this.#file, this.#backup).catch(() => undefined);
    } catch {
      // No previous cache exists on first run.
    }
    await rename(temporary, this.#file);
    await unlink(temporary).catch(() => undefined);
  }

  async #read(file: string): Promise<CacheFile | undefined> {
    try {
      const info = await stat(file);
      if (info.size > MAX_CACHE_BYTES) throw new Error("Cache file is too large");
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!isCache(parsed)) throw new Error("Unsupported cache schema");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#logger.warn("Ignored invalid cache file", { file: path.basename(file) });
      return undefined;
    }
  }
}
