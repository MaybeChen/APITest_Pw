import { z } from "zod";
import {
  caseSchema,
  planSchema,
  type TestCase,
} from "../../contracts/src/index.js";
import {
  ordered,
  redact,
  validate,
  validateDataset,
} from "../../core/src/index.js";
import type { AIProvider, PlannerInput } from "./index.js";
import { createGeneration, type Generation } from "./workflow.js";
import { ModelConnectionError } from "./connection.js";
import { taskSchemas, type PipelineTask } from "./pipeline-contracts.js";
import {
  batchItems,
  compact,
  dataCandidates,
  defaultLimits,
  inputEstimate,
  interfaceFacts,
  interfaceSummary,
  organizationEvidence,
  validatePlanData,
} from "./evidence.js";
type Checkpoint = NonNullable<Generation["organizationBatches"]>[number];
const pipelineStages = [
  "API_ORGANIZATION",
  "API_SELECTION",
  "CASE_DESIGN",
  "PLAN_DESIGN",
  "VALIDATION",
  "PLAN_REPAIR",
  "FINAL_VALIDATION",
] as const;
export function createPipeline(
  input: PlannerInput,
  provider: AIProvider,
): Generation {
  if (input.recording.scenario.length > 6000)
    throw new Error("场景说明过长，请控制在 6000 字符以内");
  const job = createGeneration(input, provider);
  const ids = new Set(job.input.recording.requests.map((r) => r.id));
  job.input.recording.dependencies = job.input.recording.dependencies.filter(
    (d) => ids.has(d.from) && ids.has(d.to),
  );
  job.authProfileRef =
    input.authProfileRef ??
    (input.environment.id === "demo" ? "demo-auth" : undefined);
  job.pipelineVersion = 2;
  job.scenario = job.input.recording.scenario;
  job.modelLimits = provider.planningLimits ?? defaultLimits;
  job.catalog = job.input.assets.map((asset) =>
    interfaceFacts(job.input.recording, asset),
  );
  job.stages = pipelineStages.map((id) => ({
    id,
    state: "PENDING",
    attempts: 0,
  }));
  return job;
}
export function forkPipeline(
  source: Generation,
  scenario: string,
  provider: AIProvider,
): Generation {
  if (
    source.pipelineVersion !== 2 ||
    !source.catalog?.length ||
    source.stages.find((s) => s.id === "API_ORGANIZATION")?.state !==
      "SUCCEEDED"
  )
    throw new Error("接口整理尚未完成，不能复用");
  if (
    source.provider.name !== provider.name ||
    source.provider.version !== provider.version
  )
    throw new Error("模型配置已改变，请重新整理接口");
  if (!scenario.trim() || scenario.length > 6000)
    throw new Error("请输入 1–6000 字符的新场景");
  const job = createPipeline(
    {
      recording: { ...source.input.recording, scenario: scenario.trim() },
      assets: source.input.assets,
      environment: source.input.environment,
      authProfileRef: source.authProfileRef,
    },
    provider,
  );
  job.catalog = structuredClone(source.catalog);
  job.catalogSourceGenerationId = source.id;
  const stage = job.stages.find((s) => s.id === "API_ORGANIZATION")!;
  stage.state = "SUCCEEDED";
  stage.output = structuredClone(job.catalog);
  stage.startedAt = Date.now();
  stage.endedAt = Date.now();
  return job;
}
function dependencyWarnings(job: Generation, selected: string[]) {
  const byRequest = new Map(
    (job.catalog ?? []).flatMap((item) =>
      item.asset.sources.map((id) => [id, item.apiId] as const),
    ),
  );
  return [
    ...new Set(
      job.input.recording.dependencies.flatMap((d) => {
        const from = byRequest.get(d.from),
          to = byRequest.get(d.to);
        return from &&
          to &&
          from !== to &&
          selected.includes(to) &&
          !selected.includes(from)
          ? [
              `候选依赖 ${from} → ${to} 尚未选择来源接口；这只是采集值匹配，请人工确认是否需要。`,
            ]
          : [];
      }),
    ),
  ];
}
export function confirmInterfaces(
  job: Generation,
  selected: string[],
  scenario: string,
  acknowledgeDependencies = false,
) {
  if (job.pipelineVersion !== 2 || job.state !== "WAITING_INTERFACE_REVIEW")
    throw new Error("当前任务不在接口确认阶段");
  if (!scenario.trim() || scenario.length > 6000)
    throw new Error("请输入 1–6000 字符的场景");
  const known = new Set(job.catalog?.map((item) => item.apiId));
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => !known.has(id))
  )
    throw new Error("所选接口必须非空、唯一，且属于本次录制目录");
  const warnings = dependencyWarnings(job, selected);
  if (warnings.length && !acknowledgeDependencies)
    throw new Error(
      warnings.join("\n") + "\n请选择依赖接口，或明确确认无需这些候选依赖。",
    );
  job.selectedApiIds = [...selected];
  job.scenario = scenario.trim();
  job.dependencyWarnings = warnings;
  job.selectionConfirmed = true;
  job.caseConfirmed = false;
  delete job.testCase;
  delete job.plan;
  delete job.datasetCandidate;
  delete job.validation;
  for (const stage of job.stages.filter((s) =>
    [
      "CASE_DESIGN",
      "PLAN_DESIGN",
      "VALIDATION",
      "PLAN_REPAIR",
      "FINAL_VALIDATION",
    ].includes(s.id),
  )) {
    stage.state = "PENDING";
    delete stage.output;
    delete stage.error;
  }
}
export function confirmCase(job: Generation, value: unknown) {
  if (
    job.pipelineVersion !== 2 ||
    !job.selectionConfirmed ||
    job.state !== "WAITING_CASE_REVIEW"
  )
    throw new Error("请先确认接口并等待语义用例生成完成");
  const testCase = caseSchema.parse(value);
  ordered(testCase.steps);
  if (
    testCase.caseId !== job.input.caseId ||
    testCase.version !== job.input.caseVersion ||
    testCase.workspaceId !== job.input.recording.workspaceId ||
    !testCase.planVersions.includes(job.input.planVersion)
  )
    throw new Error("不能修改用例身份、工作区或版本");
  if (
    !testCase.steps.some((s) => !s.executionKind || s.executionKind === "API")
  )
    throw new Error("至少需要一个 API 业务步骤；其他操作请列为前置条件");
  testCase.steps.forEach((s) => {
    s.review = "CONFIRMED";
  });
  testCase.status = "DRAFT";
  job.testCase = testCase;
  job.caseConfirmed = true;
}
export function resetScenario(job: Generation, scenario: string) {
  if (
    job.pipelineVersion !== 2 ||
    !job.catalog?.length ||
    job.state !== "WAITING_INTERFACE_REVIEW"
  )
    throw new Error("当前不能重新推荐接口");
  if (!scenario.trim() || scenario.length > 6000)
    throw new Error("请输入 1–6000 字符的场景");
  job.scenario = scenario.trim();
  delete job.selectionBatches;
  delete job.recommendations;
  delete job.selectedApiIds;
  const stage = job.stages.find((s) => s.id === "API_SELECTION")!;
  stage.state = "PENDING";
  delete stage.output;
}
export async function executePipeline(
  job: Generation,
  provider: AIProvider,
  save: (job: Generation) => Promise<void> = async () => {},
) {
  if (
    job.provider.name !== provider.name ||
    job.provider.version !== provider.version
  )
    throw new Error("模型配置已改变，请新建生成任务");
  if (!provider.runTask) throw new Error("当前 Provider 不支持新版分阶段流程");
  const limits = job.modelLimits ?? defaultLimits;
  const persist = async () => {
    job.updatedAt = Date.now();
    job.revision++;
    await save(structuredClone(job));
  };
  job.state = "RUNNING";
  delete job.error;
  const stageFor = (task: string) => job.stages.find((s) => s.id === task)!;
  const call = async <T>(
    task: PipelineTask,
    payload: unknown,
    checkpoint: Checkpoint | Generation["stages"][number],
    check?: (value: T) => void,
  ): Promise<T> => {
    let previousError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const request = previousError
        ? {
            ...(payload as object),
            previousError: previousError.slice(0, 1200),
          }
        : payload;
      const estimate = inputEstimate(task, request);
      if (estimate > limits.inputBudget)
        throw new Error(
          `${task} 输入保守估算 ${estimate} 超过预算 ${limits.inputBudget}，请缩小场景或接口范围；未发送请求。`,
        );
      checkpoint.state = "RUNNING";
      checkpoint.attempts++;
      checkpoint.startedAt ??= Date.now();
      delete checkpoint.error;
      delete checkpoint.endedAt;
      if (checkpoint !== stageFor(task)) stageFor(task).attempts++;
      if ("inputEstimate" in checkpoint) checkpoint.inputEstimate = estimate;
      stageFor(task).input = {
        inputEstimate: estimate,
        budget: limits.inputBudget,
        maxOutputTokens: limits.maxOutputTokens,
        estimator: "保守 UTF-8 字节估算，非实际 token 用量",
      };
      await persist();
      try {
        const output = taskSchemas[task].parse(
          await provider.runTask!(task, redact(request), {
            generationId: job.id,
            attempt: checkpoint.attempts,
            stage: task,
          }),
        ) as T;
        check?.(output);
        if (checkpoint !== stageFor(task)) {
          checkpoint.output = output;
          checkpoint.state = "SUCCEEDED";
          checkpoint.endedAt = Date.now();
          await persist();
        }
        return output;
      } catch (error) {
        previousError = String(
          redact(error instanceof Error ? error.message : String(error)),
        );
        checkpoint.error = previousError;
        checkpoint.state = "FAILED";
        checkpoint.endedAt = Date.now();
        provider.logValidationError?.(error, {
          generationId: job.id,
          attempt: checkpoint.attempts,
          stage: task,
        });
        await persist();
        if (
          (error instanceof ModelConnectionError && !error.retryable) ||
          /预算|截断/.test(previousError)
        )
          break;
      }
    }
    throw new Error(`${task}: ${previousError}`);
  };
  const run = async <T>(
    id: Generation["stages"][number]["id"],
    work: () => Promise<T>,
  ): Promise<T> => {
    const stage = stageFor(id);
    if (stage.state === "SUCCEEDED") return stage.output as T;
    stage.state = "RUNNING";
    if (id === "VALIDATION" || id === "FINAL_VALIDATION") stage.attempts++;
    stage.startedAt = Date.now();
    delete stage.endedAt;
    delete stage.error;
    await persist();
    try {
      const result = await work();
      stage.output = result;
      stage.state = "SUCCEEDED";
      stage.endedAt = Date.now();
      await persist();
      return result;
    } catch (error) {
      stage.state = "FAILED";
      stage.error = String(
        redact(error instanceof Error ? error.message : String(error)),
      );
      stage.endedAt = Date.now();
      throw error;
    }
  };
  try {
    job.catalog = await run("API_ORGANIZATION", async () => {
      const catalog = job.catalog!;
      const facts = catalog.map((item) =>
        organizationEvidence(job.input.recording, item),
      );
      const payload = (interfaces: typeof facts) => ({
        interfaces,
        factsOnly: true,
      });
      const groups = batchItems(facts, "API_ORGANIZATION", payload, limits);
      job.organizationBatches ??= groups.map((items, i) => ({
        id: `organization-${i + 1}`,
        apiIds: items.map((item) => item.apiId),
        state: "PENDING",
        attempts: 0,
        inputEstimate: inputEstimate("API_ORGANIZATION", payload(items)),
      }));
      const descriptions = new Map<
        string,
        z.infer<typeof taskSchemas.API_ORGANIZATION>["interfaces"][number]
      >();
      for (let i = 0; i < groups.length; i++) {
        const checkpoint = job.organizationBatches[i];
        const output =
          checkpoint.state === "SUCCEEDED"
            ? taskSchemas.API_ORGANIZATION.parse(checkpoint.output)
            : await call<z.infer<typeof taskSchemas.API_ORGANIZATION>>(
                "API_ORGANIZATION",
                payload(groups[i]),
                checkpoint,
                (value) => {
                  const ids = value.interfaces.map((item) => item.apiId);
                  if (
                    ids.length !== groups[i].length ||
                    new Set(ids).size !== ids.length ||
                    ids.some((id) => !checkpoint.apiIds.includes(id))
                  )
                    throw new Error(
                      `接口整理引用错误，必须原样且恰好一次返回：${checkpoint.apiIds.join(", ")}`,
                    );
                },
              );
        output.interfaces.forEach((item) => descriptions.set(item.apiId, item));
      }
      return catalog.map((item) => ({
        ...item,
        ...descriptions.get(item.apiId)!,
        uncertainties: [
          ...descriptions.get(item.apiId)!.uncertainties,
          ...(item.omittedSamples
            ? [
                `有 ${item.omittedSamples} 种额外请求形态未提供样例，请核对原始证据。`,
              ]
            : []),
        ],
      }));
    });
    job.recommendations = await run("API_SELECTION", async () => {
      const summaries = job.catalog!.map(interfaceSummary);
      const payload = (interfaces: typeof summaries) => ({
        scenario: job.scenario,
        interfaces,
      });
      const groups = batchItems(summaries, "API_SELECTION", payload, {
        ...limits,
        maxInterfacesPerBatch: 30,
      });
      job.selectionBatches ??= groups.map((items, i) => ({
        id: `selection-${i + 1}`,
        apiIds: items.map((item) => item.apiId),
        state: "PENDING",
        attempts: 0,
        inputEstimate: inputEstimate("API_SELECTION", payload(items)),
      }));
      const selected: z.infer<typeof taskSchemas.API_SELECTION>["selected"] =
          [],
        uncertainties: string[] = [];
      for (let i = 0; i < groups.length; i++) {
        const checkpoint = job.selectionBatches[i];
        const result =
          checkpoint.state === "SUCCEEDED"
            ? taskSchemas.API_SELECTION.parse(checkpoint.output)
            : await call<z.infer<typeof taskSchemas.API_SELECTION>>(
                "API_SELECTION",
                payload(groups[i]),
                checkpoint,
                (value) => {
                  const ids = value.selected.map((item) => item.apiId);
                  if (
                    new Set(ids).size !== ids.length ||
                    ids.some((id) => !checkpoint.apiIds.includes(id))
                  )
                    throw new Error("筛选结果引用了本批不存在或重复的接口 ID");
                },
              );
        selected.push(...result.selected);
        uncertainties.push(...result.uncertainties);
      }
      return { selected, uncertainties };
    });
    if (!job.selectionConfirmed) {
      job.selectedApiIds ??= job.recommendations.selected.map(
        (item) => item.apiId,
      );
      job.dependencyWarnings = dependencyWarnings(job, job.selectedApiIds);
      job.state = "WAITING_INTERFACE_REVIEW";
      await persist();
      return job;
    }
    const selected = job.catalog!.filter((item) =>
      job.selectedApiIds!.includes(item.apiId),
    );
    if (!job.caseConfirmed) {
      job.testCase = await run("CASE_DESIGN", async () => {
        const output = await call<TestCase>(
          "CASE_DESIGN",
          {
            scenario: job.scenario,
            caseName: job.input.recording.caseName,
            identity: {
              caseId: job.input.caseId,
              caseVersion: job.input.caseVersion,
              planVersion: job.input.planVersion,
            },
            interfaces: selected.map(interfaceSummary),
          },
          stageFor("CASE_DESIGN"),
          (value) => {
            ordered(value.steps);
          },
        );
        return {
          ...output,
          caseId: job.input.caseId,
          workspaceId: job.input.recording.workspaceId,
          version: job.input.caseVersion,
          planVersions: [job.input.planVersion],
          status: "DRAFT",
          steps: output.steps.map((s) => ({ ...s, review: "NEEDS_REVIEW" })),
        };
      });
      job.state = "WAITING_CASE_REVIEW";
      await persist();
      return job;
    }
    const candidates = dataCandidates(job.input.recording, selected);
    const byRequest = new Map(
      selected.flatMap((item) =>
        item.asset.sources.map((id) => [id, item.apiId] as const),
      ),
    );
    const dependencies = job.input.recording.dependencies
      .filter((d) => byRequest.has(d.from) && byRequest.has(d.to))
      .slice(0, 80)
      .map((d) => ({
        fromApi: byRequest.get(d.from),
        toApi: byRequest.get(d.to),
        responsePath: d.path,
        location: d.targetLocation,
        targetKey: d.targetKey,
        type: d.valueType,
        confirmed: false,
      }));
    const normalize = (plan: z.infer<typeof planSchema>) => ({
      ...plan,
      planId: `${job.id}-plan`,
      caseId: job.input.caseId,
      caseVersion: job.input.caseVersion,
      version: job.input.planVersion,
      environmentRef: job.input.environment.id,
      authProfileRef: job.authProfileRef ?? "NEEDS_CONFIGURATION",
      cleanupPolicy: "ALWAYS" as const,
      status: "DRAFT" as const,
      model: { provider: provider.name, version: provider.version },
      steps: plan.steps.map((s) => ({
        ...s,
        assertions: s.assertions.map((a) => ({ ...a, confirmed: false })),
      })),
    });
    job.plan = await run("PLAN_DESIGN", async () =>
      normalize(
        await call<z.infer<typeof planSchema>>(
          "PLAN_DESIGN",
          {
            scenario: job.scenario,
            testCase: job.testCase,
            identity: { planVersion: job.input.planVersion },
            environment: job.input.environment,
            authProfileRef: job.authProfileRef ?? "NEEDS_CONFIGURATION",
            authContract: job.authContract ?? {
              availableContexts: [],
              headers: {},
            },
            interfaces: selected.map((item) => ({
              ...interfaceSummary(item),
              asset: {
                ...item.asset,
                sources: item.samples.map((sample) => sample.requestId),
                requestSchema: compact(item.asset.requestSchema),
                responseSchema: compact(item.asset.responseSchema),
              },
              samples: item.samples,
            })),
            dependencies,
            dataParameters: candidates.map(
              ({ value: _value, ...metadata }) => metadata,
            ),
          },
          stageFor("PLAN_DESIGN"),
          (plan) => {
            validatePlanData(plan, candidates);
            if (plan.steps.some((s) => !job.selectedApiIds!.includes(s.apiId)))
              throw new Error("调用计划引用了用户未选择的接口");
          },
        ),
      ),
    );
    const inspect = () => {
      const errors = validate(
        job.testCase!,
        job.plan!,
        selected.map((item) => item.asset),
        job.input.environment,
      );
      for (const node of job.plan!.steps) {
        for (const binding of [
          ...Object.values(node.path),
          ...Object.values(node.query),
          ...Object.values(node.headers),
          ...Object.values(node.bodyBindings ?? {}),
          ...(node.body ? [node.body] : []),
        ])
          if (
            binding.source === "AUTH_CONTEXT" &&
            !(job.authContract?.availableContexts ?? []).includes(binding.name)
          )
            errors.push(
              `Unknown authentication context ${binding.name} in ${node.id}`,
            );
      }
      for (const step of job.testCase!.steps.filter(
        (s) => !s.executionKind || s.executionKind === "API",
      ))
        if (!job.plan!.steps.some((node) => node.semanticStepRef === step.id))
          errors.push(`Semantic step has no execution node: ${step.id}`);
      if (job.plan!.authProfileRef === "NEEDS_CONFIGURATION")
        errors.push("请选择已配置的 UI 认证协议");
      try {
        const values = validatePlanData(job.plan!, candidates);
        job.datasetCandidate = {
          id: `${job.id}-data`,
          name: `${job.input.recording.caseName} · 采集数据`,
          planId: job.plan!.planId,
          planVersion: job.plan!.version,
          version: 1,
          rows: [{ id: "recorded", name: "录制样例（需审核）", values }],
        };
        validateDataset(job.plan!, job.datasetCandidate);
      } catch (error) {
        errors.push(String(error));
      }
      const unique = [...new Set(errors)];
      const reviewRequired = unique.filter(
        (e) =>
          e.startsWith("Unvalidated API Asset") || e === "Unresolved header",
      );
      return {
        errors: unique,
        reviewRequired,
        blockingErrors: unique.filter((e) => !reviewRequired.includes(e)),
      };
    };
    job.validation = await run("VALIDATION", async () => inspect());
    if (job.validation.blockingErrors.length) {
      try {
        const patches = await run("PLAN_REPAIR", async () => {
          const badIds = new Set(
            job
              .plan!.steps.filter((s) =>
                job.validation!.blockingErrors.some((e) => e.includes(s.id)),
              )
              .map((s) => s.id),
          );
          if (!badIds.size)
            job.plan!.steps.slice(0, 8).forEach((s) => badIds.add(s.id));
          const nodes = job.plan!.steps.filter(
            (s) =>
              badIds.has(s.id) ||
              s.dependsOn.some((d) => badIds.has(d)) ||
              [...badIds].some((id) =>
                job
                  .plan!.steps.find((node) => node.id === id)
                  ?.dependsOn.includes(s.id),
              ),
          );
          return call<z.infer<typeof taskSchemas.PLAN_REPAIR>>(
            "PLAN_REPAIR",
            {
              errors: job.validation!.blockingErrors,
              nodes,
              interfaces: selected.map((item) => ({
                apiId: item.apiId,
                method: item.asset.method,
                path: item.asset.pathTemplate,
              })),
              parameters: job.plan!.parameters,
              authContract: job.authContract ?? {
                availableContexts: [],
                headers: {},
              },
              availableNodes: job.plan!.steps.map((s) => ({
                id: s.id,
                phase: s.phase,
                semanticStepRef: s.semanticStepRef,
                extract: s.extract,
                extractTypes: s.extractTypes,
              })),
            },
            stageFor("PLAN_REPAIR"),
            (output) => {
              const ids = output.replacements.map((s) => s.id);
              if (
                new Set(ids).size !== ids.length ||
                output.replacements.some(
                  (s) =>
                    !nodes.some((node) => node.id === s.id) ||
                    !job.selectedApiIds!.includes(s.apiId),
                )
              )
                throw new Error("局部修复不能修改范围外节点或引入未选择接口");
            },
          );
        });
        job.plan.steps = job.plan.steps.map(
          (s) =>
            patches.replacements.find(
              (replacement) => replacement.id === s.id,
            ) ?? s,
        );
        job.plan = normalize(job.plan);
      } catch {
        // Repair is optional; keep the draft and authoritative validation errors for review.
      }
      job.validation = await run("FINAL_VALIDATION", async () => inspect());
    } else
      for (const id of ["PLAN_REPAIR", "FINAL_VALIDATION"])
        stageFor(id).state = "SKIPPED";
    job.state = "NEEDS_REVIEW";
    await persist();
    return job;
  } catch (error) {
    job.state = "FAILED";
    job.error = String(
      redact(error instanceof Error ? error.message : String(error)),
    );
    await persist();
    return job;
  }
}
