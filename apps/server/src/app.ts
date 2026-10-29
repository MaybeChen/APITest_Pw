import {
  closeRetainedBrowsers,
  getRetainedBrowser,
} from "../../../packages/runner/src/retained-browsers.js";
import { UIRecorder } from "../../../packages/recorder/src/ui-recorder.js";
import {
  createPipeline,
  forkPipeline,
  executePipeline,
  confirmInterfaces,
  confirmCase,
  resetScenario,
  regeneratePlan,
} from "../../../packages/planner/src/pipeline.js";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "../../../packages/storage/src/index.js";
import {
  datasetSchema,
  type Dataset,
  caseSchema,
  planSchema,
  recordingSchema,
  environmentSchema,
  authSchema,
  type TestCase,
  type Plan,
  type Recording,
  type Asset,
  type Report,
  type Environment,
  type AuthProfile,
} from "../../../packages/contracts/src/index.js";
import {
  validate,
  validateDataset,
  allowedURL,
  atPath,
} from "../../../packages/core/src/index.js";
import { Recorder, analyze } from "../../../packages/recorder/src/index.js";
import { type AIProvider } from "../../../packages/planner/src/index.js";
import {
  createGeneration,
  executeGeneration,
  generationBundle,
  type Generation,
} from "../../../packages/planner/src/workflow.js";
import { createConfiguredAIProvider } from "./ai-config.js";
import { run, runDataset } from "../../../packages/runner/src/index.js";
import { demoArtifacts, demoEnv, demoAuth } from "./demo.js";
export async function createApp(store = new Store(), provider?: AIProvider) {
  const aiProvider = provider ?? createConfiguredAIProvider();
  await store.init();
  if (!(await store.get("initialization", "default-configurations"))) {
    if (!(await store.get("environment", demoEnv.id)))
      await store.put("environment", demoEnv.id, 1, demoEnv);
    if (!(await store.get("auth", demoAuth.id)))
      await store.put("auth", demoAuth.id, 1, demoAuth);
    await store.put("initialization", "default-configurations", 1, {
      initialized: true,
    });
  }
  async function envFor(id: string) {
    const env = await store.get<Environment>("environment", id);
    if (!env) throw new Error("Environment not configured");
    return environmentSchema.parse(env);
  }
  const app = Fastify({ bodyLimit: 16 * 1024 * 1024 });
  await app.register(swagger, {
    openapi: { info: { title: "AI API Testing Platform", version: "0.1.0" } },
  });
  await app.register(swaggerUI, { routePrefix: "/docs" });
  const sessions = new Map<string, Recorder>();
  const uiSessions = new Map<string, UIRecorder>();
  let busy = false;
  app.setErrorHandler((err, _req, reply) => {
    reply
      .code(400)
      .send({ error: err instanceof Error ? err.message : "Request failed" });
  });
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (
      origin &&
      ![
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
        "http://10.136.122.46:5173",
      ].includes(origin)
    )
      return reply.code(403).send({ error: "Untrusted origin" });
  });
  app.get("/api/environments", async () => store.latest("environment"));
  app.get("/api/auth-profiles", async () => store.latest("auth"));
  for (const [path, kind] of [
    ["environments", "environment"],
    ["auth-profiles", "auth"],
  ] as const) {
    app.delete<{ Params: { id: string } }>(
      `/api/${path}/:id`,
      async (req, reply) => {
        const { id } = req.params;
        if (
          busy ||
          sessions.size ||
          uiSessions.size ||
          activeGenerations.size ||
          generationActions.size
        )
          return reply.code(409).send({
            error: "存在录制、生成或执行中的任务，请结束后再删除配置。",
          });
        if (!(await store.get(kind, id)))
          return reply.code(404).send({ error: "配置不存在或已删除。" });
        if (kind === "environment") {
          const profiles = (await store.latest<AuthProfile>("auth")).filter(
            (profile) => profile.environmentRef === id,
          );
          if (profiles.length)
            return reply.code(409).send({
              error: `环境仍被 UI 认证协议引用：${profiles.map((profile) => profile.id).join("、")}。请先删除或修改这些协议。`,
            });
        }
        await store.remove(kind, id);
        return reply.code(204).send();
      },
    );
  }
  app.post("/api/environments", async (req, reply) => {
    const data = environmentSchema.parse(req.body);
    const { createOnly } = z
      .object({ createOnly: z.boolean().optional() })
      .parse(req.body);
    if (createOnly && (await store.get("environment", data.id)))
      return reply.code(409).send({
        error:
          "此环境名称 / 标识已存在，请使用其他名称；编辑已有配置请使用保存配置。",
      });
    const versions = await store.list<Environment>("environment");
    const version = versions.filter((v) => v.id === data.id).length + 1;
    await store.put("environment", data.id, version, data);
    return data;
  });
  app.post("/api/auth-profiles", async (req) => {
    const data = authSchema.parse(req.body);
    if (data.environmentRef) await envFor(data.environmentRef);
    for (const [name, source] of Object.entries(data.tokenSources)) {
      if (source.source === "response" || source.source === "responseHeader") {
        if (!source.url) throw new Error(`前置接口来源 ${name} 缺少 URL`);
        if (data.environmentRef)
          allowedURL(source.url, await envFor(data.environmentRef));
        if (source.source === "response") atPath({}, source.storageKey);
      }
    }
    for (const [name, binding] of Object.entries(data.headers))
      if (
        binding.source === "AUTH_CONTEXT" &&
        !Object.hasOwn(data.tokenSources, binding.name)
      )
        throw new Error(
          `Header ${name} 引用了未配置的认证变量 ${binding.name}`,
        );
    for (const input of data.actions)
      if (
        ["fill", "selectOption"].includes(input.type) &&
        !input.secretRef &&
        input.value === undefined
      )
        throw new Error(`前置 UI 输入缺少 value：${input.target}`);
    for (const [k, v] of Object.entries(data.headers))
      if (
        /authorization|token|csrf|cookie|secret/i.test(k) &&
        v.source === "STATIC"
      )
        throw new Error("Sensitive header must use a runtime source");
    const versions = await store.list<AuthProfile>("auth");
    await store.put(
      "auth",
      data.id,
      versions.filter((v) => v.id === data.id).length + 1,
      data,
    );
    return data;
  });
  app.get("/api/ui-recordings", async () => [
    ...Array.from(uiSessions.values(), (rec) => rec.snapshot()),
    ...(await store.latest("ui-recording")),
  ]);
  app.post("/api/ui-recordings", async (req, reply) => {
    if (uiSessions.size)
      return reply.code(409).send({ error: "请先停止当前前置 UI 录制" });
    const input = z
      .object({ target: z.string().url(), environmentRef: z.string().min(1) })
      .parse(req.body);
    const rec = new UIRecorder(
      await envFor(input.environmentRef),
      input.target,
    );
    uiSessions.set(rec.id, rec);
    try {
      await rec.start(process.env.RECORDER_HEADLESS === "true");
    } catch (error) {
      await rec.stop();
      uiSessions.delete(rec.id);
      throw error;
    }
    return rec.snapshot();
  });
  app.get<{ Params: { id: string } }>(
    "/api/ui-recordings/:id",
    async (req, reply) => {
      const rec =
        uiSessions.get(req.params.id)?.snapshot() ??
        (await store.get("ui-recording", req.params.id));
      return rec ?? reply.code(404).send({ error: "UI 录制不存在" });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/ui-recordings/:id/stop",
    async (req, reply) => {
      const rec = uiSessions.get(req.params.id);
      if (!rec) return reply.code(404).send({ error: "活动 UI 录制不存在" });
      const snapshot = await rec.stop();
      uiSessions.delete(rec.id);
      await store.put("ui-recording", rec.id, 1, snapshot);
      return snapshot;
    },
  );
  app.get("/api/ai-provider", async () => ({
    provider: aiProvider.name,
    model: aiProvider.version,
  }));
  app.get("/health", async () => ({ ok: true }));
  app.get("/api/workspaces", async () => {
    const deleted = new Set(
      (await store.list<{ id: string }>("workspace-deletion")).map((w) => w.id),
    );
    return (await store.list<{ id: string; name: string }>("workspace")).filter(
      (w) => !deleted.has(w.id),
    );
  });
  app.delete<{ Params: { id: string } }>(
    "/api/workspaces/:id",
    async (req, reply) => {
      const { id } = req.params;
      if (!(await store.get("workspace", id)))
        return reply.code(404).send({ error: "Workspace not found" });
      if (
        Array.from(sessions.values()).some(
          (s) => s.recording.workspaceId === id,
        )
      )
        return reply
          .code(409)
          .send({ error: "请先停止此工作区的录制，再删除工作区。" });
      if (!(await store.get("workspace-deletion", id)))
        await store.put("workspace-deletion", id, 1, {
          id,
          deletedAt: Date.now(),
        });
      return reply.code(204).send();
    },
  );
  app.post("/api/workspaces", async (req) => {
    const b = z.object({ name: z.string().min(1) }).parse(req.body);
    const w = { id: randomUUID(), ...b };
    await store.put("workspace", w.id, 1, w);
    return w;
  });
  app.get("/api/cases", async () => store.list<TestCase>("case"));
  app.get("/api/plans", async () => store.list<Plan>("plan"));
  app.get("/api/assets", async () => store.list<Asset>("asset"));
  app.get("/api/reports", async () =>
    (await store.list<Report>("report")).map((report) => ({
      ...report,
      retrySession:
        report.retrySession &&
        getRetainedBrowser(report.retrySession.reportId)?.retryStep
          ? report.retrySession
          : undefined,
    })),
  );
  app.post<{ Params: { id: string; stepId: string } }>(
    "/api/reports/:id/steps/:stepId/retry",
    async (req, reply) => {
      if (busy)
        return reply
          .code(409)
          .send({ error: "已有执行任务，请结束后再重试。" });
      busy = true;
      try {
        const source = await store.get<Report>("report", req.params.id);
        if (!source) return reply.code(404).send({ error: "运行报告不存在。" });
        const step = source.steps.find(
          (item) => item.stepId === req.params.stepId,
        );
        if (!step?.retryable)
          return reply
            .code(409)
            .send({
              error:
                "仅支持重试已执行的 GET/HEAD 查询步骤，不自动重放写操作或跳过的步骤。",
            });
        const session =
          source.retrySession &&
          getRetainedBrowser(source.retrySession.reportId);
        if (!session?.retryStep || !session.browser.isConnected())
          return reply
            .code(410)
            .send({
              error:
                "原浏览器会话已关闭或未保留。请使用 --keep-browser 启动后重新执行；单步重试不会重新登录。",
            });
        const result = await session.retryStep(source, step.stepId);
        await store.put("report", result.id, 1, result);
        return result;
      } finally {
        busy = false;
      }
    },
  );
  app.get("/api/recordings", async () => {
    const deleted = new Set(
      (await store.list<{ id: string }>("recording-deletion")).map((r) => r.id),
    );
    return [
      ...(await store.list<Recording>("recording")).filter(
        (r) => !deleted.has(r.id),
      ),
      ...Array.from(sessions.values()).map((s) => s.recording),
    ];
  });
  app.post("/api/recordings", async (req) => {
    if (sessions.size >= 2) throw new Error("Recording capacity reached");
    const b = z
      .object({
        caseName: z.string().min(1),
        scenario: z.string().min(1),
        target: z.string().url(),
        notes: z.string().optional(),
        workspaceId: z.string().optional(),
        environmentRef: z.string().default("demo"),
      })
      .parse(req.body);
    const rec = new Recorder(b, await envFor(b.environmentRef));
    try {
      await rec.start(process.env.RECORDER_HEADLESS === "true");
    } catch (e) {
      await rec.stop();
      throw e;
    }
    sessions.set(rec.recording.id, rec);
    return rec.recording;
  });
  app.get<{ Params: { id: string } }>(
    "/api/recordings/:id",
    async (req) =>
      sessions.get(req.params.id)?.recording ??
      (await store.get("recording", req.params.id)) ??
      null,
  );
  app.post<{ Params: { id: string } }>(
    "/api/recordings/:id/stop",
    async (req) => {
      const r = sessions.get(req.params.id);
      if (!r) throw new Error("Recording session not found");
      const data = await r.stop();
      await store.put("recording", data.id, 1, data);
      sessions.delete(data.id);
      return data;
    },
  );
  app.get("/api/analyses", async () => store.latest("analysis"));
  app.get<{ Params: { id: string } }>(
    "/api/recordings/:id/analysis",
    async (req) => (await store.get("analysis", req.params.id)) ?? null,
  );
  app.post<{ Params: { id: string } }>(
    "/api/recordings/:id/analyze",
    async (req) => {
      const raw = await store.get<Recording>("recording", req.params.id);
      if (!raw) throw new Error("Stop and save recording first");
      const filter = z
        .object({
          domains: z.array(z.string()).optional(),
          pathPattern: z.string().optional(),
          methods: z.array(z.string()).optional(),
          resourceTypes: z.array(z.string()).optional(),
          categories: z.array(z.string()).optional(),
          overrides: z.record(z.string(), z.boolean()).optional(),
        })
        .parse(req.body ?? {});
      const result = analyze(recordingSchema.parse(raw), filter);
      const versions = await store.list<{ recording: Recording }>("analysis");
      await store.put(
        "analysis",
        raw.id,
        versions.filter((a) => a.recording.id === raw.id).length + 1,
        result,
      );
      return result;
    },
  );
  const activeGenerations = new Map<string, Promise<Generation>>();
  const saveGeneration = async (job: Generation) => {
    await store.put("generation", job.id, job.revision, job);
  };
  const startGeneration = (job: Generation) => {
    const promise = (
      job.pipelineVersion === 2
        ? executePipeline(job, aiProvider, saveGeneration)
        : executeGeneration(job, aiProvider, saveGeneration)
    ).finally(() => activeGenerations.delete(job.id));
    activeGenerations.set(job.id, promise);
    return promise;
  };
  const newGeneration = async (body: unknown, legacy = false) => {
    const b = z
      .object({
        recording: recordingSchema,
        pipelineVersion: z.union([z.literal(1), z.literal(2)]).default(2),
        authProfileRef: z.string().optional(),
        environmentRef: z.string().default("demo"),
      })
      .parse(body);
    const job = (
      legacy || b.pipelineVersion === 1 ? createGeneration : createPipeline
    )(
      {
        authProfileRef: b.authProfileRef,
        recording: b.recording,
        assets: [],
        environment: await envFor(b.environmentRef),
      },
      aiProvider,
    );
    await saveGeneration(job);
    return job;
  };
  app.post("/api/generate", async (req) =>
    generationBundle(
      await startGeneration(await newGeneration(req.body, true)),
    ),
  );
  app.post("/api/generations", async (req) => {
    const job = await newGeneration(req.body);
    void startGeneration(job).catch((error: unknown) => app.log.error(error));
    return { id: job.id };
  });
  app.get("/api/generations", async (req) => {
    const scope = z
      .object({
        workspaceId: z.string().min(1).optional(),
        recordingId: z.string().min(1).optional(),
      })
      .parse(req.query);
    return (await store.latest<Generation>("generation"))
      .filter(
        (job) =>
          (!scope.workspaceId ||
            job.input.recording.workspaceId === scope.workspaceId) &&
          (!scope.recordingId || job.input.recording.id === scope.recordingId),
      )
      .map((job) => ({ ...job, active: activeGenerations.has(job.id) }));
  });
  app.get<{ Params: { id: string } }>("/api/generations/:id", async (req) => {
    const job = await store.get<Generation>("generation", req.params.id);
    if (!job) throw new Error("生成任务不存在");
    return { ...job, active: activeGenerations.has(job.id) };
  });
  app.post<{ Params: { id: string } }>(
    "/api/generations/:id/resume",
    async (req) => {
      const job = await store.get<Generation>("generation", req.params.id);
      if (!job) throw new Error("生成任务不存在");
      if (
        job.provider.name !== aiProvider.name ||
        job.provider.version !== aiProvider.version
      )
        throw new Error("模型名称或版本已改变，请创建新的生成任务。");
      if (activeGenerations.has(job.id)) return { id: job.id };
      if (
        [
          "NEEDS_REVIEW",
          "WAITING_INTERFACE_REVIEW",
          "WAITING_CASE_REVIEW",
          "WAITING_CONFIGURATION",
        ].includes(job.state)
      )
        return { id: job.id };
      void startGeneration(job).catch((error: unknown) => app.log.error(error));
      return { id: job.id };
    },
  );
  const generationActions = new Set<string>();
  const deletingRecordings = new Set<string>();
  app.delete<{ Params: { id: string } }>(
    "/api/recordings/:id",
    async (req, reply) => {
      const { id } = req.params;
      if (sessions.has(id))
        return reply
          .code(409)
          .send({ error: "请先停止录制，再删除历史记录。" });
      if (deletingRecordings.has(id))
        return reply.code(409).send({ error: "正在删除此记录，请稍后刷新。" });
      deletingRecordings.add(id);
      try {
        if (!(await store.get("recording", id)))
          return reply.code(404).send({ error: "录制记录不存在" });
        const jobs = (await store.latest<Generation>("generation")).filter(
          (job) => job.input.recording.id === id,
        );
        if (
          jobs.some(
            (job) =>
              activeGenerations.has(job.id) || generationActions.has(job.id),
          )
        )
          return reply
            .code(409)
            .send({ error: "此记录正在生成，请等待任务结束后再删除。" });
        if (!(await store.get("recording-deletion", id)))
          await store.put("recording-deletion", id, 1, {
            id,
            deletedAt: Date.now(),
          });
        return reply.code(204).send();
      } finally {
        deletingRecordings.delete(id);
      }
    },
  );
  for (const action of [
    "interfaces",
    "case",
    "scenario",
    "fork-scenario",
    "regenerate-plan",
  ] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/generations/:id/${action}`,
      async (req, reply) => {
        const id = req.params.id;
        if (activeGenerations.has(id) || generationActions.has(id))
          return reply
            .code(409)
            .send({ error: "任务正在运行，请等待当前阶段完成" });
        generationActions.add(id);
        try {
          const job = await store.get<Generation>("generation", id);
          if (!job) return reply.code(404).send({ error: "生成任务不存在" });
          const body = z
            .object({ revision: z.number().int().positive() })
            .passthrough()
            .parse(req.body);
          if (body.revision !== job.revision)
            return reply
              .code(409)
              .send({ error: "任务已更新，请刷新后重新确认" });
          if (action === "fork-scenario") {
            const next = forkPipeline(
              job,
              z.object({ scenario: z.string().min(1).max(6000) }).parse(body)
                .scenario,
              aiProvider,
            );
            await saveGeneration(next);
            void startGeneration(next).catch((error: unknown) =>
              app.log.error(error),
            );
            return { id: next.id };
          }
          if (action === "regenerate-plan") {
            if (
              job.provider.name !== aiProvider.name ||
              job.provider.version !== aiProvider.version
            )
              throw new Error("模型名称或版本已改变，请创建新的生成任务");
            const choice = z
              .object({ authProfileRef: z.string().min(1).optional() })
              .parse(body);
            const profile = await store.get<AuthProfile>(
              "auth",
              choice.authProfileRef ?? job.authProfileRef ?? "",
            );
            if (!profile) throw new Error("所选 UI 认证协议尚未配置");
            if (
              profile.environmentRef &&
              profile.environmentRef !== job.input.environment.id
            )
              throw new Error("UI 认证协议所属环境与当前计划不一致");
            regeneratePlan(job);
            job.authProfileRef = profile.id;
            job.authContract = {
              availableContexts: Object.keys(profile.tokenSources),
              headers: profile.headers,
              ...(profile.actions.some(
                (action) =>
                  action.secretRef &&
                  process.env[action.secretRef] === undefined,
              )
                ? {
                    missingInputRefs: [
                      ...new Set(
                        profile.actions.flatMap((action) =>
                          action.secretRef &&
                          process.env[action.secretRef] === undefined
                            ? [action.secretRef]
                            : [],
                        ),
                      ),
                    ],
                  }
                : {}),
            };
          } else if (action === "interfaces") {
            const value = z
              .object({
                selectedApiIds: z.array(z.string()).min(1),
                scenario: z.string().min(1).max(6000),
                acknowledgeDependencies: z.boolean().default(false),
                confirmed: z.literal(true),
              })
              .parse(body);
            confirmInterfaces(
              job,
              value.selectedApiIds,
              value.scenario,
              value.acknowledgeDependencies,
            );
          } else if (action === "case") {
            const value = z
              .object({
                testCase: caseSchema,
                authProfileRef: z.string().min(1),
                confirmed: z.literal(true),
              })
              .parse(body);
            const profile = await store.get<AuthProfile>(
              "auth",
              value.authProfileRef,
            );
            if (!profile) throw new Error("所选 UI 认证协议尚未配置");
            if (
              profile.environmentRef &&
              profile.environmentRef !== job.input.environment.id
            )
              throw new Error("UI 认证协议所属环境与当前计划不一致");
            confirmCase(job, value.testCase);
            job.authProfileRef = value.authProfileRef;
            job.authContract = {
              availableContexts: Object.keys(profile.tokenSources),
              headers: profile.headers,
              ...(profile.actions.some(
                (action) =>
                  action.secretRef &&
                  process.env[action.secretRef] === undefined,
              )
                ? {
                    missingInputRefs: [
                      ...new Set(
                        profile.actions.flatMap((action) =>
                          action.secretRef &&
                          process.env[action.secretRef] === undefined
                            ? [action.secretRef]
                            : [],
                        ),
                      ),
                    ],
                  }
                : {}),
            };
          } else {
            resetScenario(
              job,
              z.object({ scenario: z.string().min(1).max(6000) }).parse(body)
                .scenario,
            );
          }
          job.state = "RUNNING";
          delete job.error;
          job.revision++;
          job.updatedAt = Date.now();
          await saveGeneration(job);
          void startGeneration(job).catch((error: unknown) =>
            app.log.error(error),
          );
          return { id: job.id };
        } finally {
          generationActions.delete(id);
        }
      },
    );
  }
  app.post("/api/demo", async () => demoArtifacts(randomUUID()));
  const bundle = z.object({
    testCase: caseSchema,
    plan: planSchema,
    assets: z.array(
      (await import("../../../packages/contracts/src/index.js")).assetSchema,
    ),
  });
  app.get("/api/drafts", async () => store.list("draft"));
  app.post("/api/drafts", async (req) => {
    const data = bundle.parse(req.body);
    data.testCase.status = "DRAFT";
    data.plan.status = "DRAFT";
    const prior = await store.list<{ testCase: TestCase }>("draft");
    const revision =
      prior.filter((d) => d.testCase.caseId === data.testCase.caseId).length +
      1;
    await store.put("draft", data.testCase.caseId, revision, data);
    return { ...data, draftRevision: revision };
  });
  app.post("/api/validate", async (req) => {
    const b = bundle.parse(req.body);
    return {
      errors: validate(
        b.testCase,
        b.plan,
        b.assets,
        await envFor(b.plan.environmentRef),
      ),
    };
  });
  app.post("/api/approve", async (req) => {
    const b = bundle.extend({ confirmed: z.literal(true) }).parse(req.body);
    const testCase = { ...b.testCase, status: "APPROVED" as const };
    const plan = { ...b.plan, status: "APPROVED" as const };
    const errors = validate(
      testCase,
      plan,
      b.assets,
      await envFor(plan.environmentRef),
      true,
    );
    if (errors.length) throw new Error(errors.join("; "));
    // Immutable primary keys prohibit replacing an existing approved version.
    const oldCase = await store.get<TestCase>(
      "case",
      testCase.caseId,
      testCase.version,
    );
    const oldPlan = await store.get<Plan>("plan", plan.planId, plan.version);
    if (oldPlan)
      throw new Error("Plan version already exists: increase version");
    if (oldCase && !isDeepStrictEqual(oldCase, testCase))
      throw new Error("Case version is immutable: increase version");
    const entries: {
      kind: string;
      entityId: string;
      version: number;
      data: unknown;
    }[] = [];
    for (const asset of b.assets) {
      const old = await store.get<Asset>("asset", asset.apiId, asset.version);
      if (old && !isDeepStrictEqual(old, asset))
        throw new Error("API Asset version is immutable");
      if (!old)
        entries.push({
          kind: "asset",
          entityId: asset.apiId,
          version: asset.version,
          data: asset,
        });
    }
    if (!oldCase)
      entries.push({
        kind: "case",
        entityId: testCase.caseId,
        version: testCase.version,
        data: testCase,
      });
    entries.push({
      kind: "plan",
      entityId: plan.planId,
      version: plan.version,
      data: plan,
    });
    const datasets = await store.latest<Dataset>("dataset");
    const previous = (await store.list<Plan>("plan"))
      .filter(
        (item) => item.planId === plan.planId && item.version < plan.version,
      )
      .sort((a, b) => b.version - a.version)
      .find((item) =>
        datasets.some(
          (dataset) =>
            dataset.planId === item.planId &&
            dataset.planVersion === item.version,
        ),
      );
    if (previous) {
      for (const dataset of datasets.filter(
        (item) =>
          item.planId === plan.planId && item.planVersion === previous.version,
      )) {
        const copy: Dataset = {
          ...structuredClone(dataset),
          id: randomUUID(),
          version: 1,
          planVersion: plan.version,
        };
        if (
          copy.review &&
          (!isDeepStrictEqual(previous.parameters, plan.parameters) ||
            !isDeepStrictEqual(
              previous.dataRequirements,
              plan.dataRequirements,
            ) ||
            !isDeepStrictEqual(previous.steps, plan.steps))
        )
          copy.review.confirmed = false;
        try {
          validateDataset(plan, copy);
        } catch {
          // Incompatible datasets remain available in the UI for copying and repair.
          continue;
        }
        entries.push({
          kind: "dataset",
          entityId: copy.id,
          version: 1,
          data: copy,
        });
      }
    }
    await store.putBatch(entries);
    return { testCase, plan, assets: b.assets };
  });
  app.get("/api/datasets", async () => store.list<Dataset>("dataset"));
  app.post("/api/datasets", async (req) => {
    const input = z
      .object({
        id: datasetSchema.shape.id.default(() => randomUUID()),
      })
      .passthrough()
      .parse(req.body);
    const dataset = datasetSchema.parse(input);
    const plan = await store.get<Plan>(
      "plan",
      dataset.planId,
      dataset.planVersion,
    );
    if (!plan)
      throw new Error("Plan not found: approve and save the plan first");
    validateDataset(plan, dataset);
    if (await store.get("dataset", dataset.id, dataset.version))
      throw new Error("Dataset version already exists: increase version");
    await store.put("dataset", dataset.id, dataset.version, dataset);
    return dataset;
  });
  app.post("/api/run", async (req) => {
    if (busy) throw new Error("A run is already active");
    const b = z
      .object({
        planId: z.string(),
        version: z.number().int().positive(),
        dataset: z
          .object({ id: z.string(), version: z.number().int().positive() })
          .optional(),
      })
      .parse(req.body);
    const p = await store.get<Plan>("plan", b.planId, b.version);
    if (!p) throw new Error("Plan not found");
    const c = await store.get<TestCase>("case", p.caseId, p.caseVersion);
    if (!c) throw new Error("Case not found");
    const assets = await store.list<Asset>("asset");
    if (busy) throw new Error("A run is already active");
    busy = true;
    try {
      const profile = await store.get<AuthProfile>("auth", p.authProfileRef);
      if (!profile) throw new Error("Auth profile not configured");
      if (b.dataset) {
        const dataset = await store.get<Dataset>(
          "dataset",
          b.dataset.id,
          b.dataset.version,
        );
        if (!dataset) throw new Error("Dataset not found");
        return {
          reports: await runDataset(
            c,
            p,
            assets,
            await envFor(p.environmentRef),
            profile,
            dataset,
            async (report) => {
              await store.put("report", report.id, 1, report);
            },
          ),
        };
      }
      const report = await run(
        c,
        p,
        assets,
        await envFor(p.environmentRef),
        profile,
      );
      await store.put("report", report.id, 1, report);
      return report;
    } finally {
      busy = false;
    }
  });
  app.addHook("onClose", async () => {
    for (const rec of sessions.values()) await rec.stop();
    for (const rec of uiSessions.values()) await rec.stop();
    await Promise.allSettled(activeGenerations.values());
    await closeRetainedBrowsers();
    await aiProvider.close?.();
    store.client.close();
  });
  return app;
}
