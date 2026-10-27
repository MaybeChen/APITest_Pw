import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { observedSchema } from "../../recorder/src/index.js";
import type {
  Recording,
  Asset,
  Binding,
  Plan,
} from "../../contracts/src/index.js";
import { redact, valueKind, atPath, setAtPath } from "../../core/src/index.js";
import {
  estimateTokens,
  taskMessages,
  type PipelineTask,
  type CatalogInterface,
} from "./pipeline-contracts.js";
export const defaultLimits = {
  inputBudget: 64000,
  maxOutputTokens: 8192,
  maxInterfacesPerBatch: 6,
};
export function compact(value: unknown, depth = 0): any {
  if (typeof value === "string")
    return value.length > 512 ? value.slice(0, 512) + "[TRUNCATED]" : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return "[DEPTH LIMIT: inspect original evidence]";
  if (Array.isArray(value))
    return value.slice(0, 3).map((item) => compact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 32)
      .map(([key, item]) => [key, compact(item, depth + 1)]),
  );
}
const credential =
  /authorization|cookie|password|secret|csrf|token|signature|api.?key/i;
const protocol =
  /^(accept(?:-.*)?|content-.*|host|user-agent|sec-.*|connection|origin|referer|cache-control|pragma|upgrade-insecure-requests)$/i;
export function interfaceFacts(
  recording: Recording,
  asset: Asset,
): CatalogInterface {
  const requests = recording.requests.filter((r) =>
    asset.sources.includes(r.id),
  );
  asset = structuredClone(asset);
  // Replace historic name-based guesses with the observed header value.
  for (const [name, value] of Object.entries(requests[0]?.headers ?? {})) {
    if (protocol.test(name) || name.toLowerCase() === "cookie") continue;
    asset.headers[name] =
      !credential.test(name) &&
      redact(value, name) === value &&
      !value.includes("[REDACTED]")
        ? { source: "STATIC", value }
        : { source: "MANUAL_REVIEW" };
  }
  const variants = new Map<string, (typeof requests)[number]>();
  for (const r of requests) {
    const shape = JSON.stringify({
      query: observedSchema(r.query),
      body: observedSchema(r.body),
      response: observedSchema(r.response),
      status: r.status,
    });
    if (!variants.has(shape)) variants.set(shape, r);
  }
  const samples = [...variants.values()].slice(0, 3).map((r) => ({
    requestId: r.id,
    query: compact(r.query),
    body: compact(r.body),
    status: r.status,
    response: compact(r.response),
  }));
  return {
    apiId: asset.apiId,
    name: `${asset.method} ${asset.pathTemplate}`,
    description: "",
    uncertainties: [],
    asset: structuredClone(asset),
    querySchema: observedSchema(requests[0]?.query ?? {}),
    customHeaders: Object.fromEntries(
      Object.entries(asset.headers)
        .filter(([name]) => !protocol.test(name))
        .map(([name, binding]) => [
          name,
          {
            binding,
            ...(!credential.test(name)
              ? { sample: compact(requests[0]?.headers[name]) }
              : {}),
          },
        ]),
    ),
    samples,
    omittedSamples: Math.max(0, variants.size - samples.length),
  };
}
export function organizationEvidence(
  recording: Recording,
  item: CatalogInterface,
) {
  const requests = recording.requests.filter((r) =>
    item.asset.sources.includes(r.id),
  );
  const snapshotIds = new Set(
    requests.flatMap((r) => r.contextSnapshotRefs ?? []),
  );
  const contexts = (recording.contextSnapshots ?? [])
    .filter((s) => snapshotIds.has(s.id))
    .slice(0, 2);
  const operationIds = new Set([
    ...contexts.map((s) => s.operationId),
    ...requests.flatMap((r) =>
      r.operationCandidates.map((candidate) => candidate.operationId),
    ),
  ]);
  return {
    apiId: item.apiId,
    method: item.asset.method,
    path: item.asset.pathTemplate,
    customHeaders: item.customHeaders,
    querySchema: compact(item.querySchema),
    requestSchema: compact(item.asset.requestSchema),
    responseSchema: compact(item.asset.responseSchema),
    samples: item.samples,
    omittedVariants: item.omittedSamples,
    contexts: contexts.map((s) => ({
      id: s.id,
      operationId: s.operationId,
      phase: s.phase,
      title: s.title,
      headings: s.headings.slice(0, 3),
      region: s.region,
      elements: s.elements.slice(0, 8),
    })),
    operations: recording.operations
      .filter((o) => operationIds.has(o.id))
      .slice(0, 2)
      .map((o) => ({ id: o.id, type: o.type, context: compact(o.context) })),
  };
}
export function interfaceSummary(item: CatalogInterface) {
  return {
    apiId: item.apiId,
    name: item.name,
    description: item.description,
    method: item.asset.method,
    path: item.asset.pathTemplate,
    operationType: item.asset.operationType,
  };
}
export function inputEstimate(task: PipelineTask, payload: unknown) {
  return estimateTokens(taskMessages(task, redact(payload))) + 1024;
}
export function batchItems<T>(
  items: T[],
  task: PipelineTask,
  payload: (items: T[]) => unknown,
  limits = defaultLimits,
): T[][] {
  const result: T[][] = [];
  let batch: T[] = [];
  for (const item of items) {
    if (
      batch.length &&
      (batch.length >= limits.maxInterfacesPerBatch ||
        inputEstimate(task, payload([...batch, item])) > limits.inputBudget)
    ) {
      result.push(batch);
      batch = [];
    }
    if (inputEstimate(task, payload([item])) > limits.inputBudget)
      throw new Error(
        `单个接口的 ${task} 输入已超过预算，请缩小样例或场景；未发送模型请求。`,
      );
    batch.push(item);
  }
  if (batch.length) result.push(batch);
  return result;
}
export interface DataCandidate {
  name: string;
  type: NonNullable<Plan["parameters"]>[string];
  apiId: string;
  location: "PATH" | "QUERY" | "BODY" | "HEADER";
  path: string;
  requestId?: string;
  value: unknown;
  source?: "RECORDING" | "USER" | "MODEL_SUGGESTED" | "MISSING";
  note?: string;
}
export function dataCandidates(
  recording: Recording,
  catalog: CatalogInterface[],
): DataCandidate[] {
  const result: DataCandidate[] = [];
  const add = (
    item: CatalogInterface,
    requestId: string,
    location: DataCandidate["location"],
    path: string,
    value: unknown,
  ) => {
    if (
      value === undefined ||
      JSON.stringify(redact(value, location === "HEADER" ? path : "")) !==
        JSON.stringify(value) ||
      /\[(?:REDACTED|REQUEST BODY LIMIT|NON-JSON[^\]]*|[^\]]*OMITTED[^\]]*)\]/.test(
        JSON.stringify(value),
      )
    )
      return;
    const type = valueKind(value);
    if (type === "undefined") return;
    result.push({
      name: `data_${result.length + 1}`,
      type,
      apiId: item.apiId,
      location,
      path,
      requestId,
      value,
    });
  };
  for (const item of catalog) {
    const request = recording.requests.find((r) =>
      item.asset.sources.includes(r.id),
    );
    if (!request) continue;
    const actual = new URL(request.url).pathname.split("/");
    item.asset.pathTemplate.split("/").forEach((segment, i) => {
      const key = segment.match(/^\{(.+)\}$/)?.[1];
      if (key)
        add(item, request.id, "PATH", key, decodeURIComponent(actual[i] ?? ""));
    });
    for (const [key, value] of Object.entries(request.query))
      add(item, request.id, "QUERY", key, value);
    add(item, request.id, "BODY", "$", request.body);
    if (
      request.body &&
      typeof request.body === "object" &&
      !Array.isArray(request.body)
    )
      for (const [key, value] of Object.entries(request.body).slice(0, 24))
        if (/^[A-Za-z_][\w-]*$/.test(key))
          add(item, request.id, "BODY", `$.${key}`, value);
    for (const name of Object.keys(item.customHeaders))
      if (
        !credential.test(name) &&
        ["STATIC", "MANUAL_REVIEW"].includes(item.asset.headers[name]?.source)
      )
        add(item, request.id, "HEADER", name, request.headers[name]);
  }
  return result;
}
export function validatePlanData(plan: Plan, candidates: DataCandidate[]) {
  const known = new Map(candidates.map((p) => [p.name, p]));
  const values: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(plan.parameters ?? {})) {
    const source = known.get(name);
    if (!source || source.type !== type)
      throw new Error(`测试数据 ${name} 没有匹配的候选来源或类型`);
    if (source.source !== "MISSING")
      values[name] = structuredClone(source.value);
  }
  const check = (b: Binding | undefined, stepId: string, location: string) => {
    if (
      b?.source === "STATIC" &&
      b.value !== undefined &&
      JSON.stringify(b.value) !== "{}"
    )
      throw new Error(
        `业务输入不能嵌入流程，请使用接口采集数据的 TEST_DATA 引用；步骤 ${stepId}，位置 ${location}，没有类型和值均匹配的采集数据。请从 dataParameters 选择对应来源，不要编造参数值。`,
      );
  };
  for (const step of plan.steps) {
    for (const [key, binding] of Object.entries(step.path))
      check(binding, step.id, `path.${key}`);
    for (const [key, binding] of Object.entries(step.query))
      check(binding, step.id, `query.${key}`);
    for (const [key, binding] of Object.entries(step.bodyBindings ?? {}))
      check(binding, step.id, `bodyBindings[${key}]`);
    check(step.body, step.id, "body");
    for (const [name, binding] of Object.entries(step.headers))
      if (
        candidates.some(
          (c) =>
            c.apiId === step.apiId &&
            c.location === "HEADER" &&
            c.path.toLowerCase() === name.toLowerCase(),
        )
      )
        check(binding, step.id, `headers.${name}`);
  }
  return values;
}

// Header defaults are evidence, not a model inference. Preserve values in datasets.
export function applyRecordedHeaders(
  plan: Plan,
  catalog: CatalogInterface[],
  candidates: DataCandidate[],
  authHeaders: Record<string, Binding> = {},
): Plan {
  const result = structuredClone(plan);
  result.parameters ??= {};
  const configured = new Set(
    Object.keys(authHeaders).map((name) => name.toLowerCase()),
  );
  for (const step of result.steps) {
    const item = catalog.find((item) => item.apiId === step.apiId);
    if (!item) continue;
    for (const name of Object.keys(step.headers)) {
      if (
        configured.has(name.toLowerCase()) ||
        (!protocol.test(name) &&
          !Object.keys(item.asset.headers).some(
            (key) => key.toLowerCase() === name.toLowerCase(),
          ))
      )
        delete step.headers[name];
    }
    for (const [name, info] of Object.entries(item.customHeaders)) {
      if (configured.has(name.toLowerCase())) continue;
      const existing = Object.keys(step.headers).find(
        (key) => key.toLowerCase() === name.toLowerCase(),
      );
      const binding = existing ? step.headers[existing] : undefined;
      if (binding?.source === "RESPONSE_VARIABLE") continue;
      if (existing) delete step.headers[existing];
      const candidate = candidates.find(
        (c) =>
          c.apiId === step.apiId &&
          c.location === "HEADER" &&
          c.path.toLowerCase() === name.toLowerCase(),
      );
      if (candidate) {
        step.headers[name] = { source: "TEST_DATA", name: candidate.name };
        result.parameters[candidate.name] = candidate.type;
      } else step.headers[name] = structuredClone(info.binding) as Binding;
    }
  }
  return result;
}

// Move model-inlined evidence into data without changing its value or type.
export function parameterizeRecordedInputs(
  plan: Plan,
  candidates: DataCandidate[],
  evidence?: {
    recording: Recording;
    catalog: CatalogInterface[];
    allowSuggestions?: boolean;
  },
): Plan {
  const result = structuredClone(plan);
  result.parameters ??= {};
  for (const step of result.steps) {
    const bind = (
      binding: Binding | undefined,
      location: DataCandidate["location"],
      path: string,
    ): Binding | undefined => {
      if (!binding || !["STATIC", "TEST_DATA"].includes(binding.source))
        return binding;
      if (
        binding.source === "STATIC" &&
        location === "BODY" &&
        path === "$" &&
        binding.value &&
        typeof binding.value === "object" &&
        !Array.isArray(binding.value) &&
        Object.keys(binding.value).length === 0 &&
        Object.keys(step.bodyBindings ?? {}).length
      )
        return binding;
      if (
        binding.source === "TEST_DATA" &&
        candidates.some((c) => c.name === binding.name)
      )
        return binding;
      let candidate = candidates.find(
        (c) =>
          c.apiId === step.apiId &&
          c.location === location &&
          c.path === path &&
          binding.source === "STATIC" &&
          isDeepStrictEqual(c.value, binding.value),
      );
      // The model sees compact samples. Search full local evidence only for the
      // exact requested field, rather than expanding every request into tokens.
      if (!candidate && evidence) {
        const item = evidence.catalog.find((item) => item.apiId === step.apiId);
        for (const request of evidence.recording.requests) {
          if (!item?.asset.sources.includes(request.id)) continue;
          let value: unknown;
          try {
            if (location === "BODY") {
              setAtPath(undefined, path, null); // Same safe path grammar as runner.
              value = atPath(request.body, path);
            } else if (location === "QUERY") value = request.query[path];
            else if (location === "PATH") {
              const segments = item.asset.pathTemplate.split("/");
              const index = segments.indexOf(`{${path}}`);
              if (index >= 0)
                value = decodeURIComponent(
                  new URL(request.url).pathname.split("/")[index] ?? "",
                );
            }
          } catch {
            continue;
          }
          if (
            value === undefined ||
            JSON.stringify(redact(value, path)) !== JSON.stringify(value) ||
            /\[(?:REDACTED|REQUEST BODY LIMIT|NON-JSON[^\]]*|[^\]]*OMITTED[^\]]*)\]/.test(
              JSON.stringify(value),
            )
          )
            continue;
          const name = `data_ref_${createHash("sha256")
            .update(JSON.stringify([step.apiId, request.id, location, path]))
            .digest("hex")
            .slice(0, 24)}`;
          if (
            binding.source === "STATIC"
              ? !isDeepStrictEqual(value, binding.value)
              : binding.source !== "TEST_DATA" || binding.name !== name
          )
            continue;
          const type = valueKind(value);
          if (type === "undefined") continue;
          candidate = {
            name,
            apiId: step.apiId,
            location,
            path,
            requestId: request.id,
            type,
            value: structuredClone(value),
          };
          candidates.push(candidate);
          break;
        }
      }
      if (
        !candidate &&
        binding.source === "STATIC" &&
        binding.value !== undefined &&
        evidence?.allowSuggestions
      ) {
        const type = valueKind(binding.value);
        if (type !== "undefined") {
          const name = `data_input_${createHash("sha256")
            .update(JSON.stringify([step.id, step.apiId, location, path]))
            .digest("hex")
            .slice(0, 24)}`;
          const safe =
            JSON.stringify(redact(binding.value, path)) ===
              JSON.stringify(binding.value) &&
            !/\[(?:REDACTED|REQUEST BODY LIMIT|NON-JSON[^\]]*|[^\]]*OMITTED[^\]]*)\]/.test(
              JSON.stringify(binding.value),
            );
          candidate = {
            name,
            apiId: step.apiId,
            location,
            path,
            type,
            value: safe ? structuredClone(binding.value) : undefined,
            source: safe ? "MODEL_SUGGESTED" : "MISSING",
            note: safe
              ? "模型提出的新测试值，未找到匹配录制证据；请核对场景并确认或修改"
              : "输入已脱敏或含敏感内容，请人工提供安全测试数据或改用认证/上游绑定",
          };
          const prior = candidates.findIndex((c) => c.name === name);
          if (prior >= 0) candidates[prior] = candidate;
          else candidates.push(candidate);
        }
      }
      if (
        !candidate &&
        binding.source === "TEST_DATA" &&
        evidence?.allowSuggestions &&
        result.parameters?.[binding.name]
      ) {
        candidate = {
          name: binding.name,
          apiId: step.apiId,
          location,
          path,
          type: result.parameters[binding.name],
          value: undefined,
          source: "MISSING",
          note: "引用没有采集来源或候选值，请人工填写",
        };
        candidates.push(candidate);
      }
      if (!candidate) return binding;
      result.parameters![candidate.name] = candidate.type;
      return { source: "TEST_DATA", name: candidate.name };
    };
    for (const [key, binding] of Object.entries(step.path))
      step.path[key] = bind(binding, "PATH", key)!;
    for (const [key, binding] of Object.entries(step.query))
      step.query[key] = bind(binding, "QUERY", key)!;
    step.body = bind(step.body, "BODY", "$");
    for (const [key, binding] of Object.entries(step.bodyBindings ?? {}))
      step.bodyBindings![key] = bind(binding, "BODY", key)!;
  }
  return result;
}
