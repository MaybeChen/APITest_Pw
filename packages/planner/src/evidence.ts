import { observedSchema } from "../../recorder/src/index.js";
import type {
  Recording,
  Asset,
  Binding,
  Plan,
} from "../../contracts/src/index.js";
import { redact, valueKind } from "../../core/src/index.js";
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
  requestId: string;
  value: unknown;
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
      JSON.stringify(redact(value)) !== JSON.stringify(value) ||
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
      throw new Error(`测试数据 ${name} 没有匹配的采集来源或类型`);
    values[name] = structuredClone(source.value);
  }
  const check = (b: Binding | undefined) => {
    if (
      b?.source === "STATIC" &&
      b.value !== undefined &&
      JSON.stringify(b.value) !== "{}"
    )
      throw new Error(
        "业务输入不能嵌入流程，请使用接口采集数据的 TEST_DATA 引用",
      );
  };
  for (const step of plan.steps) {
    Object.values(step.path).forEach(check);
    Object.values(step.query).forEach(check);
    Object.values(step.bodyBindings ?? {}).forEach(check);
    check(step.body);
    for (const [name, binding] of Object.entries(step.headers))
      if (
        candidates.some(
          (c) =>
            c.apiId === step.apiId &&
            c.location === "HEADER" &&
            c.path.toLowerCase() === name.toLowerCase(),
        )
      )
        check(binding);
  }
  return values;
}
