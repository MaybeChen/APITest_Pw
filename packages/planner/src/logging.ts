import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { redact } from "../../core/src/index.js";
export interface ModelLogEvent {
  event: "request" | "response" | "error" | "validation_error";
  requestId?: string;
  generationId: string;
  attempt: number;
  stage?: string;
  purpose: "planning" | "connectivity";
  provider: string;
  model: string;
  endpoint?: string;
  durationMs?: number;
  status?: number;
  data: unknown;
}
export type ModelLogger = (event: ModelLogEvent) => void;
export interface ModelLoggingOptions {
  enabled: boolean;
  console: boolean;
  file?: string;
  maxChars: number;
  maxFileBytes: number;
  backups: number;
}
export function sanitizeModelLog(
  value: unknown,
  secrets: string[] = [],
  key = "",
): unknown {
  if (value instanceof Error) {
    const details = value as Error & { code?: unknown; issues?: unknown };
    return sanitizeModelLog(
      {
        name: value.name,
        message: value.message,
        code: details.code,
        issues: details.issues,
      },
      secrets,
    );
  }
  const masked = redact(value, key);
  if (typeof masked === "string") {
    let text = masked;
    for (const secret of secrets)
      if (secret) text = text.split(secret).join("[REDACTED]");
    const trimmed = text.trim();
    const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = fence ? fence[1] : trimmed;
    if (/^[{[]/.test(candidate)) {
      try {
        const safe = JSON.stringify(
          sanitizeModelLog(JSON.parse(candidate), secrets),
          null,
          2,
        );
        return fence ? "```json\n" + safe + "\n```" : safe;
      } catch {
        /* Non-JSON model text still receives credential masking. */
      }
    }
    return text
      .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, "[REDACTED]")
      .replace(
        /(["']?(?:password|passwd|secret|authorization|cookie|csrf[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
        '$1"[REDACTED]"',
      );
  }
  if (Array.isArray(masked))
    return masked.map((item) => sanitizeModelLog(item, secrets));
  if (masked && typeof masked === "object")
    return Object.fromEntries(
      Object.entries(masked).map(([name, item]) => [
        name,
        sanitizeModelLog(item, secrets, name),
      ]),
    );
  return masked;
}
export function createModelLogger(
  options: ModelLoggingOptions,
  secrets: string[] = [],
): ModelLogger {
  return (event) => {
    if (!options.enabled) return;
    try {
      const safe = sanitizeModelLog(event, secrets) as Record<string, unknown>;
      const data = JSON.stringify(safe.data) ?? "null";
      const record = {
        timestamp: new Date().toISOString(),
        ...safe,
        data:
          data.length > options.maxChars
            ? data.slice(0, options.maxChars)
            : safe.data,
        truncated: data.length > options.maxChars,
        originalChars: data.length,
      };
      const line = JSON.stringify(record) + "\n";
      if (options.console) console.log("[ai] " + line.trimEnd());
      if (options.file) {
        mkdirSync(dirname(options.file), { recursive: true });
        if (
          existsSync(options.file) &&
          statSync(options.file).size + Buffer.byteLength(line) >
            options.maxFileBytes
        ) {
          for (let index = options.backups - 1; index >= 1; index--) {
            const previous = options.file + "." + index;
            if (existsSync(previous))
              renameSync(previous, options.file + "." + (index + 1));
          }
          renameSync(options.file, options.file + ".1");
        }
        appendFileSync(options.file, line, "utf8");
      }
    } catch {
      console.warn("[ai-log] 无法写入模型调试日志，请检查日志路径和权限。");
    }
  };
}
