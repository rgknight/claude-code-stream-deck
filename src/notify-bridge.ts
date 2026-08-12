import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import type { DiagnosticLogger } from "./logger.js";
import { spoolDirectory } from "./paths.js";

const MAX_EVENT_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 1024;
const NOTIFY_EVENT_TYPES = new Set([
  "session-start",
  "prompt-submit",
  "notification",
  "permission-request",
  "pre-tool",
  "post-tool",
  "stop",
  "stop-failure",
  "session-end"
]);
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export type NotifyEventType =
  | "session-start"
  | "prompt-submit"
  | "notification"
  | "permission-request"
  | "pre-tool"
  | "post-tool"
  | "stop"
  | "stop-failure"
  | "session-end";

export interface NotifyEvent {
  version: 2;
  type: NotifyEventType;
  sessionId: string;
  cwd: string;
  observedAt: string;
  notificationType?: string | undefined;
  message?: string | undefined;
  source?: string | undefined;
  reason?: string | undefined;
  /** Tool name, carried only by `pre-tool` and `permission-request` events. */
  toolName?: string | undefined;
}

export interface NotifyBridgeHealth {
  running: boolean;
  port?: number | undefined;
  accepted: number;
  rejected: number;
  spooled: number;
  lastError?: string | undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  return encoded.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || !value || value.includes("\0")) return undefined;
  return value.slice(0, maxLength);
}

export function parseNotifyEvent(value: unknown): NotifyEvent {
  if (!value || typeof value !== "object") throw new Error("Notify payload must be an object");
  const raw = value as Record<string, unknown>;
  const type = typeof raw.type === "string" ? raw.type.slice(0, 100) : "unknown";
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.slice(0, 200) : "";
  const cwd = typeof raw.cwd === "string" ? raw.cwd.slice(0, 32_768) : "";
  if (raw.version !== 2) throw new Error("Notify payload has an unsupported version");
  if (!NOTIFY_EVENT_TYPES.has(type)) throw new Error("Notify payload has an unsupported event type");
  if (!EVENT_ID_PATTERN.test(sessionId)) throw new Error("Notify payload contains an invalid session ID");
  if (!cwd || cwd.includes("\0") || !path.isAbsolute(cwd)) {
    throw new Error("Notify payload is missing a trusted absolute cwd");
  }
  const notificationType = optionalString(raw.notificationType, 64);
  const message = typeof raw.message === "string" && raw.message ? truncateUtf8(raw.message, MAX_MESSAGE_BYTES) : undefined;
  const source = optionalString(raw.source, 100);
  const reason = optionalString(raw.reason, 100);
  const toolName = optionalString(raw.toolName, 100);
  return {
    version: 2,
    type: type as NotifyEventType,
    sessionId,
    cwd,
    observedAt:
      typeof raw.observedAt === "string" && Number.isFinite(Date.parse(raw.observedAt)) ? raw.observedAt : new Date().toISOString(),
    ...(notificationType ? { notificationType } : {}),
    ...(message ? { message } : {}),
    ...(source ? { source } : {}),
    ...(reason ? { reason } : {}),
    ...(toolName ? { toolName } : {})
  };
}

export class NotifyBridgeServer {
  readonly #dataDirectory: string;
  readonly #logger: DiagnosticLogger;
  readonly #onEvent: (event: NotifyEvent) => Promise<void>;
  #server: http.Server | undefined;
  #lock: FileHandle | undefined;
  #health: NotifyBridgeHealth = { running: false, accepted: 0, rejected: 0, spooled: 0 };

  constructor(dataDirectory: string, logger: DiagnosticLogger, onEvent: (event: NotifyEvent) => Promise<void>) {
    this.#dataDirectory = dataDirectory;
    this.#logger = logger;
    this.#onEvent = onEvent;
  }

  get health(): NotifyBridgeHealth {
    return { ...this.#health };
  }

  async start(): Promise<void> {
    if (this.#server) return;
    await mkdir(this.#dataDirectory, { recursive: true });
    if (!this.#lock) await this.#acquireLock();
    try {
      const token = randomBytes(32).toString("base64url");
      const server = http.createServer((request, response) => this.#handleRequest(request, response, token));
      server.requestTimeout = 5_000;
      server.headersTimeout = 5_000;
      server.keepAliveTimeout = 1_000;
      server.maxHeadersCount = 32;
      this.#server = server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Notify bridge did not obtain a loopback port");
      const endpoint = JSON.stringify({ version: 1, host: "127.0.0.1", port: address.port, token });
      const temporary = path.join(this.#dataDirectory, `notify-endpoint.${process.pid}.tmp`);
      await writeFile(temporary, endpoint, { encoding: "utf8", mode: 0o600 });
      const endpointPath = path.join(this.#dataDirectory, "notify-endpoint.json");
      await unlink(endpointPath).catch(() => undefined);
      await rename(temporary, endpointPath);
      this.#health = { ...this.#health, running: true, port: address.port, lastError: undefined };
      await this.drainSpool();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(path.join(this.#dataDirectory, "notify-endpoint.json")).catch(() => undefined);
    await this.#lock?.close().catch(() => undefined);
    this.#lock = undefined;
    await unlink(path.join(this.#dataDirectory, "plugin.lock")).catch(() => undefined);
    this.#health = { ...this.#health, running: false, port: undefined };
  }

  async #acquireLock(): Promise<void> {
    const lockPath = path.join(this.#dataDirectory, "plugin.lock");
    try {
      this.#lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let active = false;
      try {
        const pid = Number.parseInt(await readFile(lockPath, "utf8"), 10);
        if (Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          active = true;
        }
      } catch {
        active = false;
      }
      if (active) throw new Error("Another Claude Code Monitor plugin process owns the notify bridge");
      await unlink(lockPath).catch(() => undefined);
      this.#lock = await open(lockPath, "wx", 0o600);
    }
    await this.#lock.writeFile(String(process.pid), "utf8");
    await this.#lock.sync();
  }

  async drainSpool(): Promise<void> {
    const spool = spoolDirectory();
    let names: string[];
    try {
      names = (await readdir(spool)).filter((name) => /^[A-Za-z0-9_.-]+\.json$/.test(name)).sort().slice(0, 500);
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(spool, name);
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVENT_BYTES) continue;
        const event = parseNotifyEvent(JSON.parse(await readFile(file, "utf8")));
        await this.#onEvent(event);
        await unlink(file);
        this.#health.spooled += 1;
      } catch {
        this.#logger.warn("Ignored invalid notify spool event", { file: name.slice(0, 100) });
      }
    }
  }

  #handleRequest(request: http.IncomingMessage, response: http.ServerResponse, token: string): void {
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    const remote = request.socket.remoteAddress;
    if (
      request.method !== "POST" ||
      request.url !== "/event" ||
      request.headers.authorization !== `Bearer ${token}` ||
      contentType !== "application/json" ||
      (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1")
    ) {
      this.#health.rejected += 1;
      response.writeHead(404, { "Cache-Control": "no-store", Connection: "close" }).end();
      return;
    }
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_EVENT_BYTES) chunks.push(chunk);
      else tooLarge = true;
    });
    request.on("end", () => {
      void (async () => {
        try {
          if (tooLarge) {
            this.#health.rejected += 1;
            response.writeHead(413, { "Cache-Control": "no-store", Connection: "close" }).end();
            return;
          }
          const event = parseNotifyEvent(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          await this.#onEvent(event);
          this.#health.accepted += 1;
          response.writeHead(204, { "Cache-Control": "no-store", Connection: "close" }).end();
        } catch (error) {
          this.#health.rejected += 1;
          this.#health.lastError = error instanceof Error ? error.message.slice(0, 200) : "Invalid event";
          if (!response.headersSent) response.writeHead(400, { "Cache-Control": "no-store", Connection: "close" }).end();
        }
      })();
    });
    request.on("error", () => {
      this.#health.rejected += 1;
      if (!response.headersSent) response.writeHead(400, { "Cache-Control": "no-store", Connection: "close" }).end();
    });
  }
}
