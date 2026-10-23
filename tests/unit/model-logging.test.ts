import { it, expect, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createModelLogger,
  sanitizeModelLog,
  type ModelLogEvent,
  type ModelLoggingOptions,
} from "../../packages/planner/src/logging";
import { ModelAIProvider, generate } from "../../packages/planner/src/index";
import { analyze } from "../../packages/recorder/src/index";
import { demoArtifacts, demoEnv } from "../../apps/server/src/demo";
import type { Recording } from "../../packages/contracts/src/index";
const options: ModelLoggingOptions = {
  enabled: true,
  console: false,
  maxChars: 64000,
  maxFileBytes: 10485760,
  backups: 3,
};
const event: ModelLogEvent = {
  event: "response",
  requestId: "r",
  generationId: "g",
  attempt: 1,
  purpose: "planning",
  provider: "OpenAICompatible",
  model: "qwen",
  data: {
    choices: [
      {
        message: {
          content:
            '```json\n{"password":"secret-password","nested":{"access_token":"secret-token"},"note":"known-api-key"}\n```',
        },
      },
    ],
  },
};
it("redacts JSON embedded in model messages, prose credentials and known key echoes", () => {
  const safe = JSON.stringify(sanitizeModelLog(event, ["known-api-key"]));
  expect(safe).not.toMatch(/secret-password|secret-token|known-api-key/);
  expect(safe).toContain("REDACTED");
  expect(
    String(
      sanitizeModelLog(
        'Authorization: Bearer opaque-credential password="another-password"',
      ),
    ),
  ).not.toMatch(/opaque-credential|another-password/);
});
it("writes correlated JSONL events and prints console logs only when enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-logs-"));
  const file = join(dir, "logs", "model.jsonl");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const logger = createModelLogger({ ...options, console: true, file }, [
      "known-api-key",
    ]);
    logger(event);
    const log = JSON.parse(readFileSync(file, "utf8"));
    expect(log.requestId).toBe("r");
    expect(log.timestamp).toBeTruthy();
    expect(output).toHaveBeenCalledTimes(1);
    expect(readFileSync(file, "utf8")).not.toMatch(
      /secret-password|secret-token|known-api-key/,
    );
    const disabledFile = join(dir, "disabled.jsonl");
    createModelLogger({
      ...options,
      enabled: false,
      console: true,
      file: disabledFile,
    })(event);
    expect(existsSync(disabledFile)).toBe(false);
    expect(output).toHaveBeenCalledTimes(1);
  } finally {
    output.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("marks truncated payloads and rotates bounded log files", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-log-limits-"));
  const file = join(dir, "model.jsonl");
  try {
    const logger = createModelLogger({
      ...options,
      file,
      maxChars: 100,
      maxFileBytes: 1024,
      backups: 2,
    });
    for (let i = 0; i < 10; i++)
      logger({ ...event, data: { text: "x".repeat(2000) } });
    const log = JSON.parse(
      readFileSync(file, "utf8").trim().split("\n").at(-1)!,
    );
    expect(log.truncated).toBe(true);
    expect(log.originalChars).toBeGreaterThan(100);
    expect(log.data.length).toBe(100);
    expect(existsSync(file + ".1")).toBe(true);
    expect(readdirSync(dir).length).toBeLessThanOrEqual(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("logs validation failures and retries under one generation ID", async () => {
  const recording: Recording = {
    id: "r",
    caseName: "业务操作",
    scenario: "测试日志",
    target: demoEnv.baseURL,
    notes: "",
    startedAt: 1,
    state: "STOPPED",
    operations: [],
    dependencies: [],
    redactions: [],
    requests: [
      {
        id: "req",
        url: demoEnv.baseURL + "/api/orders",
        method: "GET",
        resourceType: "fetch",
        startedAt: 2,
        headers: { authorization: "Bearer input-credential" },
        query: {},
        status: 200,
        response: [],
        category: "BUSINESS",
        initiator: "UNKNOWN",
        operationCandidates: [],
      },
    ],
  };
  const input = analyze(recording);
  const bundle = demoArtifacts();
  let calls = 0;
  const events: ModelLogEvent[] = [];
  const provider = new ModelAIProvider({
    endpoint: "https://model.example.test/v1/chat/completions",
    model: "qwen",
    logger: (item) => events.push(item),
    requester: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify(
                ++calls === 1
                  ? { invalid: true }
                  : { testCase: bundle.testCase, plan: bundle.plan },
              ),
            },
          },
        ],
      }),
    }),
  });
  await generate(provider, { ...input, environment: demoEnv });
  expect(events.map((e) => e.event)).toEqual([
    "request",
    "response",
    "validation_error",
    "request",
    "response",
  ]);
  expect(new Set(events.map((e) => e.generationId)).size).toBe(1);
  expect(events[0].attempt).toBe(1);
  expect(events[3].attempt).toBe(2);
  expect(events[0].requestId).not.toBe(events[3].requestId);
  expect(JSON.stringify(events)).not.toContain("input-credential");
});
it("preserves model results when a logging sink fails", async () => {
  const provider = new ModelAIProvider({
    endpoint: "https://model.example.test/v1/chat/completions",
    model: "qwen",
    logger: () => {
      throw new Error("logging unavailable");
    },
    requester: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' } }],
      }),
    }),
  });
  expect((await provider.checkConnection()).model).toBe("qwen");
});
