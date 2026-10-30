import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Plan,
  Recording,
  TestCase,
  Environment,
  Binding,
  Step,
} from "../../contracts/src/index.js";
import {
  atPath,
  setAtPath,
  ordered,
  valueKind,
  observedHeaderBinding,
} from "../../core/src/index.js";
import type { CatalogInterface } from "./pipeline-contracts.js";
import type { CallIntent } from "./call-intent.js";
export type CompilerIssue = { kind: "BLOCKING" | "REVIEW"; message: string };
export function preflightHeaders(
  catalog: CatalogInterface[],
  headers: Record<string, Binding>,
  available: string[],
  recording?: Recording,
) {
  const issues: CompilerIssue[] = [];
  const configured = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const item of catalog)
    for (const [key, value] of Object.entries(item.asset.headers)) {
      const binding = configured.get(key.toLowerCase());
      if (
        binding?.source === "AUTH_CONTEXT" &&
        !available.includes(binding.name)
      )
        issues.push({
          kind: "BLOCKING",
          message: `认证 Header ${key} 引用了未配置的变量 ${binding.name}`,
        });
      if (
        !binding &&
        value.source === "MANUAL_REVIEW" &&
        /authorization|token|csrf|secret|signature|api.?key/i.test(key) &&
        !recording?.dependencies.some(
          (dependency) =>
            dependency.targetLocation === "HEADER" &&
            dependency.targetKey?.toLowerCase() === key.toLowerCase() &&
            item.asset.sources.includes(dependency.to) &&
            catalog.some((source) =>
              source.asset.sources.includes(dependency.from),
            ),
        )
      )
        issues.push({
          kind: "BLOCKING",
          message: `认证 Header ${key} 缺少前置 UI 提取及 Header 绑定`,
        });
    }
  return [...new Map(issues.map((issue) => [issue.message, issue])).values()];
}
function knownInputShape(value: unknown, samples: unknown[]): boolean {
  const present = samples.filter((sample) => sample !== undefined);
  if (!present.length) return false;
  if (Array.isArray(value)) {
    const arrays = present.filter(Array.isArray);
    return (
      arrays.length > 0 &&
      value.every((item) => knownInputShape(item, arrays.flat()))
    );
  }
  if (value && typeof value === "object") {
    const objects = present.filter(
      (sample) =>
        sample && typeof sample === "object" && !Array.isArray(sample),
    ) as Record<string, unknown>[];
    return (
      objects.length > 0 &&
      Object.entries(value).every(([key, child]) =>
        knownInputShape(
          child,
          objects
            .filter((sample) => Object.hasOwn(sample, key))
            .map((sample) => sample[key]),
        ),
      )
    );
  }
  return true;
}
function schemaSample(schema: Record<string, unknown>, depth = 0): unknown {
  if (!schema || typeof schema !== "object" || depth > 8) return null;
  if (
    schema.type === "object" &&
    schema.properties &&
    typeof schema.properties === "object"
  )
    return Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        schemaSample(value as Record<string, unknown>, depth + 1),
      ]),
    );
  if (
    schema.type === "array" &&
    schema.items &&
    typeof schema.items === "object"
  )
    return [schemaSample(schema.items as Record<string, unknown>, depth + 1)];
  return schema.type === "object" ? {} : null;
}
export function compileCallIntent(
  intent: CallIntent,
  context: {
    recording: Recording;
    catalog: CatalogInterface[];
    testCase: TestCase;
    environment: Environment;
    authProfileRef: string;
    planId: string;
    version: number;
    provider: { name: string; version: string };
    generatedAt: number;
    authHeaders?: Record<string, Binding>;
  },
): { plan: Plan; issues: CompilerIssue[] } {
  const issues: CompilerIssue[] = [];
  const fail = (message: string) => {
    issues.push({ kind: "BLOCKING", message });
  };
  const semantic = new Map(
    context.testCase.steps
      .filter((step) => !step.executionKind || step.executionKind === "API")
      .map((step) => [step.id, step]),
  );
  ordered(intent.calls); // Reject duplicate nodes, missing dependencies and cycles.
  const assets = new Map(
    context.catalog.map((item) => [item.apiId, item.asset]),
  );
  const requests = new Map<string, Recording["requests"][number]>();
  const steps: Step[] = [];
  for (const call of intent.calls) {
    if (!semantic.has(call.semanticStepRef))
      throw new Error(
        `调用 ${call.id} 引用了未确认的 API 语义步骤 ${call.semanticStepRef}`,
      );
    const asset = assets.get(call.apiId);
    if (!asset)
      throw new Error(`调用 ${call.id} 引用了未选择的接口 ${call.apiId}`);
    const request = context.recording.requests.find(
      (request) =>
        asset.sources.includes(request.id) &&
        (!call.requestId || request.id === call.requestId),
    );
    if (!request) throw new Error(`调用 ${call.id} 没有属于该接口的录制请求`);
    requests.set(call.id, request);
    const path: Step["path"] = {};
    const segments = new URL(request.url).pathname.split("/");
    asset.pathTemplate.split("/").forEach((segment, index) => {
      const name = segment.match(/^\{(.+)\}$/)?.[1];
      if (name)
        path[name] = {
          source: "STATIC",
          value: decodeURIComponent(segments[index] ?? ""),
        };
    });
    const configuredHeaders = new Set(
      Object.keys(context.authHeaders ?? {}).map((name) => name.toLowerCase()),
    );
    const headers = Object.fromEntries(
      Object.entries(request.headers)
        .filter(([key]) => !configuredHeaders.has(key.toLowerCase()))
        .map(([key, value]) => [key, observedHeaderBinding(key, value)]),
    );
    const status = request.status;
    const assertions: Step["assertions"] = [];
    if (status && Number.isInteger(status) && status >= 100 && status <= 599)
      assertions.push({
        kind: "status",
        operator: "eq",
        value: status,
        basis: "RECORDING",
        confirmed: false,
      });
    for (const check of call.checks) {
      if (check.kind === "status") {
        if (
          check.operator !== "eq" ||
          typeof check.value !== "number" ||
          !Number.isInteger(check.value) ||
          check.value < 100 ||
          check.value > 599
        ) {
          fail(`调用 ${call.id} 的 HTTP 状态预期无效`);
          continue;
        }
        const previous = assertions.findIndex(
          (assertion) => assertion.kind === "status",
        );
        if (previous >= 0) assertions.splice(previous, 1);
        assertions.push({
          kind: "status",
          operator: "eq",
          value: check.value,
          basis: check.value === status ? "RECORDING" : "INFERRED",
          confirmed: false,
          ...(check.value !== status
            ? {
                basisNote: "模型提出的场景预期，与录制状态不同，需核对业务契约",
              }
            : {}),
        });
      } else {
        if (!check.path) {
          fail(`调用 ${call.id} 的 JSON 预期缺少字段路径`);
          continue;
        }
        try {
          atPath({}, check.path);
          const observed = context.recording.requests
            .filter((r) => asset.sources.includes(r.id))
            .some((r) => atPath(r.response, check.path!) !== undefined);
          if (!observed) {
            fail(
              `调用 ${call.id} 的响应字段 ${check.path} 没有录制依据，不能编造断言`,
            );
            continue;
          }
          if (["contains", "notContains"].includes(check.operator)) {
            const arrays = context.recording.requests
              .filter((r) => asset.sources.includes(r.id))
              .map((r) => atPath(r.response, check.path!))
              .filter(Array.isArray);
            const matcher = check.value;
            if (
              matcher === undefined ||
              (matcher !== null &&
                typeof matcher === "object" &&
                !Array.isArray(matcher) &&
                !Object.keys(matcher).length) ||
              !arrays.length ||
              (matcher &&
                typeof matcher === "object" &&
                !Array.isArray(matcher) &&
                !arrays.some((items) =>
                  items.some(
                    (item) =>
                      item &&
                      typeof item === "object" &&
                      Object.keys(matcher).every((key) =>
                        Object.hasOwn(item, key),
                      ),
                  ),
                ))
            ) {
              fail(`调用 ${call.id} 的数组匹配预期缺少有效值或字段录制依据`);
              continue;
            }
          }
          if (check.operator === "eq" && check.value === undefined) {
            fail(`调用 ${call.id} 的相等断言缺少预期值`);
            continue;
          }
          assertions.push({
            kind: "json",
            path: check.path,
            operator: check.operator,
            ...(["eq", "contains", "notContains"].includes(check.operator)
              ? { value: check.value }
              : {}),
            basis: "INFERRED",
            basisNote: "字段来自录制，业务预期仍需确认",
            confirmed: false,
          });
        } catch {
          fail(`调用 ${call.id} 的响应路径 ${check.path} 不受执行器支持`);
        }
      }
    }
    if (!assertions.length)
      throw new Error(`调用 ${call.id} 缺少录制状态或明确预期，无法编译断言`);
    steps.push({
      id: call.id,
      semanticStepRef: call.semanticStepRef,
      apiId: call.apiId,
      apiVersion: asset.version,
      phase: ["CLEANUP", "RESTORE"].includes(
        semantic.get(call.semanticStepRef)?.purpose ?? "BUSINESS",
      )
        ? "CLEANUP"
        : "API",
      dependsOn: [...call.dependsOn],
      path,
      query: Object.fromEntries(
        Object.entries(request.query).map(([key, value]) => [
          key,
          { source: "STATIC" as const, value },
        ]),
      ),
      ...(request.body !== undefined
        ? {
            body: {
              source: "STATIC" as const,
              value: structuredClone(request.body),
            },
          }
        : {}),
      bodyBindings: {},
      bodyType: /application\/x-www-form-urlencoded/i.test(
        request.headers["content-type"] ?? "",
      )
        ? "form"
        : "json",
      headers,
      extract: {},
      extractTypes: {},
      assertions,
      parallelSafe:
        asset.risk === "READ" &&
        asset.operationType === "READ" &&
        ["GET", "HEAD"].includes(asset.method),
      resourceLocks:
        asset.risk === "READ"
          ? []
          : [`${context.environment.id}:${asset.pathTemplate}`],
      timeoutMs: 10000,
      retries: 0,
      failurePolicy: ["CLEANUP", "RESTORE"].includes(
        semantic.get(call.semanticStepRef)?.purpose ?? "BUSINESS",
      )
        ? "CONTINUE"
        : "STOP",
      ownsResource: false,
      requiresOwnership:
        asset.operationType === "DELETE" ||
        (["CLEANUP", "RESTORE"].includes(
          semantic.get(call.semanticStepRef)?.purpose ?? "BUSINESS",
        ) &&
          asset.risk !== "READ"),
    });
  }
  const nodes = new Map(steps.map((step) => [step.id, step]));
  // Semantic dependencies may pass through UI/manual prerequisites.
  const apiAncestors = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    const step = context.testCase.steps.find((step) => step.id === id);
    if (!step) throw new Error(`语义步骤依赖不存在：${id}`);
    return step.dependsOn.flatMap((parent) =>
      semantic.has(parent) ? [parent] : apiAncestors(parent, seen),
    );
  };
  for (const call of intent.calls) {
    const step = nodes.get(call.id)!;
    for (const parent of apiAncestors(call.semanticStepRef)) {
      const calls = intent.calls.filter(
        (other) => other.semanticStepRef === parent,
      );
      if (!calls.length) fail(`语义步骤 ${parent} 没有接口调用`);
      for (const parentCall of calls)
        if (!step.dependsOn.includes(parentCall.id))
          step.dependsOn.push(parentCall.id);
    }
    const targets = new Set<string>();
    for (const input of call.inputs) {
      const target = `${input.location}:${input.path}`;
      if (targets.has(target)) {
        fail(`调用 ${call.id} 的输入 ${target} 被重复定义`);
        continue;
      }
      targets.add(target);
      if (input.location === "PATH" && !Object.hasOwn(step.path, input.path)) {
        fail(`调用 ${call.id} 的路径参数 ${input.path} 不存在`);
        continue;
      }
      if (input.location === "BODY") {
        try {
          setAtPath(undefined, input.path, null);
        } catch {
          fail(`调用 ${call.id} 的请求体路径 ${input.path} 无效`);
          continue;
        }
      }
      if (
        input.location === "HEADER" &&
        Object.keys(context.authHeaders ?? {}).some(
          (name) => name.toLowerCase() === input.path.toLowerCase(),
        )
      ) {
        issues.push({
          kind: "REVIEW",
          message: `调用 ${call.id} 的 Header ${input.path} 沿用用户配置的前置 UI 协议，已忽略模型覆盖`,
        });
        continue;
      }
      if (
        input.location === "HEADER" &&
        !Object.keys(assets.get(call.apiId)!.headers).some(
          (name) => name.toLowerCase() === input.path.toLowerCase(),
        )
      ) {
        fail(`调用 ${call.id} 的 Header ${input.path} 没有采集依据`);
        continue;
      }
      if (input.location === "HEADER" && input.source.kind !== "RESPONSE") {
        fail(
          `调用 ${call.id} 的 Header ${input.path} 不能由模型改写采集值或认证配置`,
        );
        continue;
      }
      if (input.source.kind === "VALUE" && input.location === "BODY") {
        const asset = assets.get(call.apiId)!;
        const samples = [
          ...context.recording.requests
            .filter((request) => asset.sources.includes(request.id))
            .map((request) => atPath(request.body, input.path)),
          atPath(schemaSample(asset.requestSchema), input.path),
        ];
        if (!knownInputShape(input.source.value, samples)) {
          fail(
            `调用 ${call.id} 的请求字段 ${input.path} 缺少接口结构依据，不能编造新的字段或 action=delete 能力`,
          );
          continue;
        }
      }
      if (
        input.location === "QUERY" &&
        !context.recording.requests.some(
          (request) =>
            assets.get(call.apiId)!.sources.includes(request.id) &&
            Object.hasOwn(request.query, input.path),
        )
      ) {
        fail(`调用 ${call.id} 的查询参数 ${input.path} 没有接口依据`);
        continue;
      }
      let binding: Binding;
      if (input.source.kind === "VALUE")
        binding = {
          source: "STATIC",
          value: structuredClone(input.source.value),
        };
      else if (input.source.kind === "RECORDING") {
        const source = input.source;
        const asset = assets.get(call.apiId)!;
        const request = source.requestId
          ? context.recording.requests.find(
              (r) => r.id === source.requestId && asset.sources.includes(r.id),
            )
          : requests.get(call.id);
        if (!request) {
          fail(`调用 ${call.id} 的录制输入来源不属于该接口`);
          continue;
        }
        let value: unknown;
        try {
          value =
            input.location === "BODY"
              ? atPath(request.body, source.path ?? input.path)
              : input.location === "QUERY"
                ? request.query[source.path ?? input.path]
                : undefined;
          if (input.location === "PATH") {
            const index = asset.pathTemplate
              .split("/")
              .indexOf(`{${source.path ?? input.path}}`);
            if (index >= 0)
              value = decodeURIComponent(
                new URL(request.url).pathname.split("/")[index] ?? "",
              );
          }
        } catch {
          /* diagnosed below */
        }
        if (value === undefined) {
          fail(`调用 ${call.id} 的录制字段 ${input.path} 没有值`);
          continue;
        }
        binding = { source: "STATIC", value: structuredClone(value) };
      } else {
        const source = input.source;
        const producer = nodes.get(source.fromCall);
        if (!producer) {
          fail(`调用 ${call.id} 的上游 ${source.fromCall} 不存在`);
          continue;
        }
        let value: unknown;
        try {
          value = atPath(requests.get(source.fromCall)?.response, source.path);
        } catch {
          /* diagnosed below */
        }
        const type = valueKind(value);
        if (type === "undefined") {
          fail(`调用 ${call.id} 的上游响应字段 ${source.path} 没有录制依据`);
          continue;
        }
        const targetRequest = requests.get(call.id)!;
        let recordedTarget: unknown;
        if (input.location === "BODY")
          recordedTarget = atPath(targetRequest.body, input.path);
        else if (input.location === "QUERY")
          recordedTarget = targetRequest.query[input.path];
        else if (input.location === "HEADER")
          recordedTarget = targetRequest.headers[input.path];
        else {
          const position = assets
            .get(call.apiId)!
            .pathTemplate.split("/")
            .indexOf(`{${input.path}}`);
          if (position >= 0)
            recordedTarget = decodeURIComponent(
              new URL(targetRequest.url).pathname.split("/")[position] ?? "",
            );
        }
        const comparable =
          input.location === "PATH" ||
          input.location === "QUERY" ||
          input.location === "HEADER";
        const matches =
          isDeepStrictEqual(recordedTarget, value) ||
          (comparable &&
            (typeof value === "string" || typeof value === "number") &&
            recordedTarget === String(value));
        const targetType = valueKind(recordedTarget);
        const scenarioBinding =
          !matches &&
          input.location !== "HEADER" &&
          assets.get(call.apiId)!.operationType !== "DELETE" &&
          ["string", "number", "boolean"].includes(type) &&
          (targetType === type ||
            (comparable && targetType === "string" && type === "number"));
        if (
          recordedTarget === undefined ||
          (!matches && !scenarioBinding) ||
          value === "[REDACTED]" ||
          recordedTarget === "[REDACTED]"
        ) {
          fail(
            `调用 ${call.id} 的 ${input.location} ${input.path} 与上游 ${source.fromCall} ${source.path} 没有可验证的采集流转证据`,
          );
          continue;
        }
        if (scenarioBinding)
          issues.push({
            kind: "REVIEW",
            message: `调用 ${call.id} 的 ${input.location} ${input.path} 使用上游 ${source.fromCall} ${source.path} 构造新场景；字段与类型有采集依据，但值不同于历史请求。请确认场景需要此流转，且执行时上游字段存在`,
          });
        const variable = `var_${createHash("sha256")
          .update(JSON.stringify([source.fromCall, source.path]))
          .digest("hex")
          .slice(0, 20)}`;
        producer.extract[variable] = source.path;
        producer.extractTypes![variable] = type;
        binding = {
          source: "RESPONSE_VARIABLE",
          name: variable,
          fromStep: producer.id,
          expectedType: type,
        };
        if (!step.dependsOn.includes(producer.id))
          step.dependsOn.push(producer.id);
        if (
          (assets.get(call.apiId)!.operationType === "DELETE" ||
            step.phase === "CLEANUP") &&
          input.location === "PATH"
        ) {
          const producerAsset = assets.get(producer.apiId)!;
          const recordedTarget = step.path[input.path];
          if (
            producerAsset.operationType === "CREATE" &&
            producer.id !== step.id &&
            recordedTarget?.source === "STATIC" &&
            (isDeepStrictEqual(recordedTarget.value, value) ||
              ((typeof value === "number" || typeof value === "string") &&
                recordedTarget.value === String(value)))
          ) {
            producer.ownsResource = true;
            producer.resourceVariable = variable;
            step.resourceVariable = variable;
          } else
            fail(
              `调用 ${call.id} 的${assets.get(call.apiId)!.operationType === "DELETE" ? "删除" : "恢复"}目标没有本次创建并提取的资源证据`,
            );
        }
      }
      if (input.location === "BODY") {
        if (input.path === "$") step.body = binding;
        else step.bodyBindings![input.path] = binding;
      } else if (input.location === "PATH") step.path[input.path] = binding;
      else if (input.location === "QUERY") step.query[input.path] = binding;
      else step.headers[input.path] = binding;
    }
  }
  for (const id of semantic.keys())
    if (!intent.calls.some((call) => call.semanticStepRef === id))
      fail(`语义步骤 ${id} 没有接口调用`);
  ordered(steps);
  for (const step of steps.filter((step) => step.phase === "CLEANUP")) {
    step.parallelSafe = false;
    if (assets.get(step.apiId)!.risk !== "READ") {
      if (!step.resourceVariable)
        fail(
          `恢复/清理步骤 ${step.id} 缺少本次运行的资源所有权依据，不能直接修改已有数据`,
        );
      else step.onlyIfOwned = true;
    }
  }
  for (const step of [...steps])
    if (assets.get(step.apiId)!.operationType === "DELETE") {
      if (!step.resourceVariable)
        fail(
          `调用 ${step.id} 缺少已验证的资源所有权，不能删除录制中的历史资源`,
        );
      else if (step.phase !== "CLEANUP") {
        let cleanupId = `cleanup_${step.id}`;
        while (steps.some((node) => node.id === cleanupId)) cleanupId += "_";
        steps.push({
          ...structuredClone(step),
          id: cleanupId,
          phase: "CLEANUP",
          dependsOn: steps.filter((s) => s.phase === "API").map((s) => s.id),
          parallelSafe: false,
          failurePolicy: "CONTINUE",
          onlyIfOwned: true,
        });
      }
    }
  for (const message of intent.uncertainties)
    issues.push({ kind: "REVIEW", message });
  return {
    plan: {
      planId: context.planId,
      caseId: context.testCase.caseId,
      caseVersion: context.testCase.version,
      version: context.version,
      status: "DRAFT",
      environmentRef: context.environment.id,
      policyRef: "recording-compiler-v2",
      authProfileRef: context.authProfileRef,
      uiActions: [],
      applicationInitializations: (
        context.recording.applicationCandidates ?? []
      )
        .filter((item) => item.enabled)
        .flatMap((candidate) => {
          const first = ordered(steps).find((step) =>
            candidate.requestIds.includes(requests.get(step.id)?.id ?? ""),
          );
          return first
            ? [
                {
                  navigationId: candidate.navigationId,
                  url: candidate.url,
                  newWindow: candidate.newWindow,
                  beforeStepId: first.id,
                },
              ]
            : [];
        }),
      steps,
      parameters: {},
      compilation: {
        version: 2,
        blockers: issues
          .filter((issue) => issue.kind === "BLOCKING")
          .map((issue) => issue.message),
      },
      execution: { maxConcurrency: 4 },
      cleanupPolicy: "ALWAYS",
      model: {
        provider: context.provider.name,
        version: context.provider.version,
      },
      generatedAt: context.generatedAt,
    },
    issues,
  };
}
