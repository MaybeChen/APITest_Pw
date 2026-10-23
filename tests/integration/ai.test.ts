import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfiguredAIProvider } from "../../apps/server/src/ai-config";
import { generate } from "../../packages/planner/src/index";
import { demoArtifacts, demoEnv } from "../../apps/server/src/demo";
import type { Recording } from "../../packages/contracts/src/index";
import { Store } from "../../packages/storage/src/index";
import { createApp } from "../../apps/server/src/app";

const recording: Recording = {
  id: "model-input",
  caseName: "删除订单",
  scenario: "删除专属测试订单并验证不存在",
  target: demoEnv.baseURL,
  notes: "",
  startedAt: 1,
  state: "STOPPED",
  operations: [],
  dependencies: [],
  redactions: [],
  requests: [
    {
      id: "demo-contract",
      url: demoEnv.baseURL + "/api/orders",
      method: "POST",
      resourceType: "fetch",
      startedAt: 2,
      headers: { authorization: "Bearer sensitive-test-token" },
      query: {},
      body: { password: "sensitive-test-password" },
      status: 201,
      response: { id: "order" },
      category: "BUSINESS",
      operationCandidates: [],
      initiator: "UNKNOWN",
      keep: true,
    },
  ],
};

it("uses the configured internal Qwen model without requiring an API key", async () => {
  const provider = createConfiguredAIProvider(undefined, {});
  expect(provider.name).toBe("OpenAICompatible");
  expect(provider.version).toBe("qwen");
});

it("calls a configured v1 base URL without authorization and parses linked model artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-ai-"));
  const configPath = join(dir, "ai.json");
  const received: {
    path: string;
    authorization: string | undefined;
    body: Record<string, any>;
  }[] = [];
  const bundle = demoArtifacts("qwen-response");
  bundle.testCase.steps[0].title = "创建本次运行专属的测试订单";
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      received.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body: JSON.parse(data),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  "```json\n" +
                  JSON.stringify({
                    testCase: bundle.testCase,
                    plan: bundle.plan,
                  }) +
                  "\n```",
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: "openai-compatible",
        baseURL: `http://127.0.0.1:${port}/llm/qwen3.6/v1/`,
        model: "qwen",
        timeoutMs: 3000,
      }),
    );
    const provider = createConfiguredAIProvider(configPath, {
      AI_ENDPOINT: "http://unused.invalid/chat/completions",
      AI_MODEL: "unused-model",
    });
    const result = await generate(provider, {
      recording,
      assets: bundle.assets,
      environment: demoEnv,
    });
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe("/llm/qwen3.6/v1/chat/completions");
    expect(received[0].authorization).toBeUndefined();
    expect(received[0].body.model).toBe("qwen");
    expect(received[0].body.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(received[0].body)).not.toContain(
      "sensitive-test-token",
    );
    expect(JSON.stringify(received[0].body)).not.toContain(
      "sensitive-test-password",
    );
    expect(received[0].body.messages[0].content).toContain("中文业务语言");
    expect(result.plan.model).toEqual({
      provider: "OpenAICompatible",
      version: "qwen",
    });
    expect(result.testCase.steps[0].title).toBe("创建本次运行专属的测试订单");
    expect(result.plan.status).toBe("DRAFT");
    const app = await createApp(new Store("file::memory:"), provider);
    try {
      expect((await app.inject({ url: "/api/ai-provider" })).json()).toEqual({
        provider: "OpenAICompatible",
        model: "qwen",
      });
    } finally {
      await app.close();
    }
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: "openai-compatible",
        baseURL: `http://127.0.0.1:${port}`,
        model: "qwen",
        apiKeyEnv: "MODEL_TEST_KEY",
      }),
    );
    expect(() => createConfiguredAIProvider(configPath, {})).toThrow(
      "MODEL_TEST_KEY",
    );
    writeFileSync(configPath, JSON.stringify({ provider: "mock" }));
    expect(createConfiguredAIProvider(configPath, {}).name).toBe(
      "MockAIProvider",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps model failures visible rather than silently returning Mock output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-ai-error-"));
  const configPath = join(dir, "ai.json");
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(503);
    res.end("unavailable");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: "openai-compatible",
        baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        model: "qwen",
      }),
    );
    await expect(
      generate(createConfiguredAIProvider(configPath, {}), {
        recording,
        assets: demoArtifacts().assets,
        environment: demoEnv,
      }),
    ).rejects.toThrow("Model HTTP 503");
    expect(calls).toBe(2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
});
