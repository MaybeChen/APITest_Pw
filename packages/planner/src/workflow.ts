import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  recordingSchema,
  assetSchema,
  environmentSchema,
  caseSchema,
  planSchema,
  type Recording,
} from "../../contracts/src/index.js";
import { ordered, redact, validate } from "../../core/src/index.js";
import { analyze } from "../../recorder/src/index.js";
import type { AIProvider, PlannerInput } from "./index.js";
import {
  businessFlowSchema,
  generationStageSchema,
  repairedSchema,
  stageIds,
  type AIStage,
  type BusinessFlow,
} from "./stages.js";
import { ModelConnectionError } from "./connection.js";
export const generationSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  state: z.enum(["RUNNING", "FAILED", "NEEDS_REVIEW"]),
  provider: z.object({ name: z.string(), version: z.string() }),
  createdAt: z.number(),
  updatedAt: z.number(),
  input: z.object({
    recording: recordingSchema,
    assets: z.array(assetSchema),
    environment: environmentSchema,
    caseId: z.string(),
    caseVersion: z.number().int().positive(),
    planVersion: z.number().int().positive(),
  }),
  stages: z.array(generationStageSchema),
  error: z.string().optional(),
  businessFlow: businessFlowSchema.optional(),
  testCase: caseSchema.optional(),
  plan: planSchema.optional(),
  validation: z
    .object({
      errors: z.array(z.string()),
      blockingErrors: z.array(z.string()),
      reviewRequired: z.array(z.string()),
    })
    .optional(),
});
export type Generation = z.infer<typeof generationSchema>;
export function createGeneration(
  input: PlannerInput,
  provider: AIProvider,
): Generation {
  if (!input.recording.requests.length)
    throw new Error(
      "录制中没有 Fetch/XHR 请求，请检查请求域名白名单，并在录制期间执行业务操作后重新录制。",
    );
  const selected = analyze(input.recording, {
    overrides: Object.fromEntries(
      input.recording.requests
        .filter((r) => r.keep !== undefined)
        .map((r) => [r.id, !!r.keep]),
    ),
  });
  const requests = selected.recording.requests.filter(
    (r) => r.keep && r.category !== "AUTH_BOOTSTRAP",
  );
  if (!requests.length)
    throw new Error(
      "没有保留的业务候选请求，请在分析页勾选需要的请求，或重新分析录制；登录请求不能作为业务步骤。",
    );
  const snapshotIds = new Set(
    requests.flatMap((r) => r.contextSnapshotRefs ?? []),
  );
  const recording: Recording = {
    ...selected.recording,
    requests,
    contextSnapshots: selected.recording.contextSnapshots?.filter((s) =>
      snapshotIds.has(s.id),
    ),
  };
  return {
    id: randomUUID(),
    revision: 1,
    state: "RUNNING",
    provider: { name: provider.name, version: provider.version },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    input: {
      recording: redact(recording),
      assets: selected.assets,
      environment: input.environment,
      caseId: input.caseId ?? randomUUID(),
      caseVersion: input.caseVersion ?? 1,
      planVersion: input.planVersion ?? 1,
    },
    stages: stageIds.map((id) => ({ id, state: "PENDING", attempts: 0 })),
  };
}
function checkBusiness(flow: BusinessFlow, input: Generation["input"]) {
  ordered(flow.steps);
  const requests = new Set(input.recording.requests.map((r) => r.id));
  const assets = new Set(input.assets.map((a) => a.apiId));
  for (const step of flow.steps) {
    if (
      step.requestRefs.some((id) => !requests.has(id)) ||
      step.apiRefs.some((id) => !assets.has(id))
    )
      throw new Error(
        "Business flow references evidence outside the selected recording",
      );
  }
  for (const edge of flow.parameterCandidates)
    if (!requests.has(edge.fromRequest) || !requests.has(edge.toRequest))
      throw new Error("Parameter candidate references unknown request");
}
export async function executeGeneration(
  job: Generation,
  provider: AIProvider,
  save: (job: Generation) => Promise<void> = async () => {},
): Promise<Generation> {
  if (
    provider.name !== job.provider.name ||
    provider.version !== job.provider.version
  )
    throw new Error(
      "模型配置已改变，请创建新的生成任务，避免混合不同模型的阶段结果。",
    );
  if (!provider.runStage) throw new Error("当前 Provider 不支持分阶段工作流。");
  job.state = "RUNNING";
  delete job.error;
  const persist = async () => {
    job.updatedAt = Date.now();
    job.revision++;
    await save(structuredClone(job));
  };
  const run = async <T>(
    id: (typeof stageIds)[number],
    input: unknown,
    work: (attempt: number) => Promise<T>,
    model = false,
  ): Promise<T> => {
    const stage = job.stages.find((s) => s.id === id)!;
    if (stage.state === "SUCCEEDED") return stage.output as T;
    stage.state = "RUNNING";
    stage.startedAt = Date.now();
    delete stage.endedAt;
    delete stage.error;
    stage.input = input;
    await persist();
    for (let attempt = 0; attempt < (model ? 2 : 1); attempt++) {
      stage.attempts++;
      try {
        const output = await work(stage.attempts);
        stage.output = output;
        delete stage.error;
        stage.state = "SUCCEEDED";
        stage.endedAt = Date.now();
        await persist();
        return stage.output as T;
      } catch (error) {
        stage.error = String(
          redact(error instanceof Error ? error.message : String(error)),
        );
        provider.logValidationError?.(error, {
          generationId: job.id,
          attempt: stage.attempts,
          stage: id,
        });
        await persist();
        if (error instanceof ModelConnectionError && !error.retryable) break;
      }
    }
    stage.state = "FAILED";
    stage.endedAt = Date.now();
    job.state = "FAILED";
    job.error = `${id}: ${stage.error}`;
    await persist();
    throw new Error(job.error);
  };
  const model = async <T>(
    id: AIStage,
    schema: z.ZodType<T>,
    artifacts: Record<string, unknown>,
  ) =>
    run(
      id,
      {
        recordingId: job.input.recording.id,
        dependsOn: job.stages
          .filter((s) => s.state === "SUCCEEDED")
          .map((s) => s.id),
      },
      async (attempt) => {
        const output = schema.parse(
          await provider.runStage!(
            id,
            redact(job.input),
            redact({
              ...artifacts,
              previousStageError: job.stages.find((s) => s.id === id)?.error,
            }),
            { generationId: job.id, attempt, stage: id },
          ),
        );
        if (id === "BUSINESS_FLOW")
          checkBusiness(output as BusinessFlow, job.input);
        return output;
      },
      true,
    );
  try {
    await run(
      "EVIDENCE",
      { recordingId: job.input.recording.id },
      async () => ({
        requestIds: job.input.recording.requests.map((r) => r.id),
        snapshotIds:
          job.input.recording.contextSnapshots?.map((s) => s.id) ?? [],
        assetIds: job.input.assets.map((a) => a.apiId),
        dependencies: job.input.recording.dependencies,
        operations: job.input.recording.operations.length,
      }),
    );
    job.businessFlow = await model("BUSINESS_FLOW", businessFlowSchema, {});
    job.testCase = await model("SEMANTIC_CASE", caseSchema, {
      businessFlow: job.businessFlow,
    });
    job.testCase.workspaceId = job.input.recording.workspaceId;
    job.testCase.status = "DRAFT";
    job.testCase.steps.forEach((s) => (s.review = "NEEDS_REVIEW"));
    job.plan = await model("EXECUTION_PLAN", planSchema, {
      businessFlow: job.businessFlow,
      testCase: job.testCase,
    });
    job.plan.status = "DRAFT";
    job.plan.model = { provider: provider.name, version: provider.version };
    job.plan.steps.forEach((s) =>
      s.assertions.forEach((a) => (a.confirmed = false)),
    );
    const inspect = () => {
      const errors = validate(
        job.testCase!,
        job.plan!,
        job.input.assets,
        job.input.environment,
      );
      if (
        job.testCase!.caseId !== job.input.caseId ||
        job.testCase!.version !== job.input.caseVersion ||
        job.plan!.version !== job.input.planVersion
      )
        errors.push("Generated artifact identity/version mismatch");
      for (const semantic of job.testCase!.steps)
        if (
          !job.plan!.steps.some((step) => step.semanticStepRef === semantic.id)
        )
          errors.push(`Semantic step has no execution node: ${semantic.id}`);
      const reviewRequired = errors.filter(
        (e) =>
          e.startsWith("Unvalidated API Asset") || e === "Unresolved header",
      );
      return {
        errors,
        reviewRequired,
        blockingErrors: errors.filter((e) => !reviewRequired.includes(e)),
      };
    };
    job.validation = await run(
      "VALIDATION",
      { caseId: job.testCase.caseId, planId: job.plan.planId },
      async () => inspect(),
    );
    if (job.validation.blockingErrors.length) {
      const fixed = await model("REPAIR", repairedSchema, {
        businessFlow: job.businessFlow,
        testCase: job.testCase,
        plan: job.plan,
        errors: job.validation.blockingErrors,
      });
      job.testCase = fixed.testCase;
      job.plan = fixed.plan;
      job.testCase.workspaceId = job.input.recording.workspaceId;
      job.testCase.status = "DRAFT";
      job.testCase.steps.forEach((s) => (s.review = "NEEDS_REVIEW"));
      job.plan.status = "DRAFT";
      job.plan.model = { provider: provider.name, version: provider.version };
      job.plan.steps.forEach((s) =>
        s.assertions.forEach((a) => (a.confirmed = false)),
      );
      job.validation = await run(
        "FINAL_VALIDATION",
        { caseId: job.testCase.caseId, planId: job.plan.planId },
        async () => inspect(),
      );
    } else
      for (const id of ["REPAIR", "FINAL_VALIDATION"])
        job.stages.find((s) => s.id === id)!.state = "SKIPPED";
    job.state = "NEEDS_REVIEW";
    await persist();
    return job;
  } catch (error) {
    if (!job.error) {
      job.state = "FAILED";
      job.error = String(
        redact(error instanceof Error ? error.message : String(error)),
      );
      await persist();
    }
    return job;
  }
}
export function generationBundle(job: Generation) {
  if (job.state !== "NEEDS_REVIEW" || !job.testCase || !job.plan)
    throw new Error(job.error ?? "生成工作流尚未完成");
  return {
    testCase: job.testCase,
    plan: job.plan,
    assets: job.input.assets,
    workflow: job,
  };
}
