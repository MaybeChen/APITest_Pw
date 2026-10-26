import { RE2JS } from "re2js";
import { randomUUID } from "node:crypto";
import {
  caseSchema,
  planSchema,
  assetSchema,
  type Plan,
  type TestCase,
  type Asset,
  type Environment,
  type Binding,
  type Dataset,
} from "../../contracts/src/index.js";
const sensitive =
  /password|passwd|secret|cookie|authorization|token|csrf|signature|credit.?card|cardnumber|cvv|api.?key/i;
export function redact(value: unknown, key = ""): any {
  if (sensitive.test(key)) {
    if (
      value &&
      typeof value === "object" &&
      "source" in value &&
      [
        "TEST_DATA",
        "ENVIRONMENT_VARIABLE",
        "AUTH_CONTEXT",
        "RESPONSE_VARIABLE",
        "CLIENT_MANAGED",
        "MANUAL_REVIEW",
        "RUNTIME_GENERATED",
      ].includes(String((value as { source: unknown }).source))
    )
      return value;
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v, k)]),
    );
  if (typeof value === "string") {
    if (/^(Bearer |Basic )/i.test(value)) return "[REDACTED]";
    return value
      .replace(
        /([?&](?:[^=&]*(?:token|password|secret|key|signature)[^=&]*)=)[^&#]*/gi,
        "$1[REDACTED]",
      )
      .replace(/\b\d{13,19}\b/g, "[REDACTED]");
  }
  return value;
}
export function atPath(value: unknown, path: string): unknown {
  if (!path || path === "$") return value;
  const parts = path
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".");
  if (parts.some((p) => ["__proto__", "constructor", "prototype"].includes(p)))
    throw new Error("Unsafe JSON path");
  return parts.reduce<unknown>(
    (v, k) =>
      v != null && typeof v === "object"
        ? (v as Record<string, unknown>)[k]
        : undefined,
    value,
  );
}
export function ordered<T extends { id: string; dependsOn: string[] }>(
  steps: T[],
): T[] {
  const map = new Map(steps.map((s) => [s.id, s]));
  if (map.size !== steps.length) throw new Error("Duplicate step ID");
  const seen = new Set<string>(),
    active = new Set<string>(),
    out: T[] = [];
  function visit(id: string) {
    if (active.has(id)) throw new Error("Dependency cycle");
    if (seen.has(id)) return;
    const s = map.get(id);
    if (!s) throw new Error(`Missing dependency ${id}`);
    active.add(id);
    s.dependsOn.forEach(visit);
    active.delete(id);
    seen.add(id);
    out.push(s);
  }
  steps.forEach((s) => visit(s.id));
  return out;
}
const compiledHostPatterns = new Map<string, RE2JS>();
function hostnameMatches(pattern: string, hostname: string) {
  let compiled = compiledHostPatterns.get(pattern);
  if (!compiled) {
    compiled = RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
    if (compiledHostPatterns.size >= 100)
      compiledHostPatterns.delete(compiledHostPatterns.keys().next().value!);
    compiledHostPatterns.set(pattern, compiled);
  }
  return compiled.matcher(hostname).find();
}
export function shouldCaptureRequest(
  url: string,
  resourceType: string,
  env: Environment,
): boolean {
  if (!["fetch", "xhr"].includes(resourceType)) return false;
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  const rules = env.recordingRequestDomains;
  if (!rules?.length) return true;
  return rules.some((rule) =>
    typeof rule === "string"
      ? parsed.hostname.toLowerCase() === rule.toLowerCase()
      : hostnameMatches(rule.hostnameRegex, parsed.hostname),
  );
}
export function valueKind(
  value: unknown,
): "string" | "number" | "boolean" | "object" | "array" | "null" | "undefined" {
  return value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : (typeof value as ReturnType<typeof valueKind>);
}
export function setAtPath(
  root: unknown,
  path: string,
  value: unknown,
): unknown {
  if (path === "$" || path === "") return structuredClone(value);
  if (!/^\$(?:\.[A-Za-z_][\w-]*|\[\d+\])+$/.test(path))
    throw new Error("Unsupported body binding path");
  const parts = path
    .slice(1)
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  if (
    parts.some((key) => ["__proto__", "constructor", "prototype"].includes(key))
  )
    throw new Error("Unsafe JSON path");
  const result = structuredClone(root ?? (/^\d+$/.test(parts[0]) ? [] : {}));
  if (!result || typeof result !== "object")
    throw new Error("Body bindings require an object or array");
  let current = result as Record<string, unknown>;
  parts.forEach((key, index) => {
    if (index === parts.length - 1) {
      current[key] = structuredClone(value);
      return;
    }
    if (current[key] === undefined)
      current[key] = /^\d+$/.test(parts[index + 1]) ? [] : {};
    if (!current[key] || typeof current[key] !== "object")
      throw new Error("Body binding crosses scalar value");
    current = current[key] as Record<string, unknown>;
  });
  return result;
}
export function allowedURL(url: string, env: Environment) {
  const u = new URL(url);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    !env.allowedOrigins.some((rule) =>
      typeof rule === "string"
        ? rule === u.origin
        : u.protocol === (rule.protocol ?? "https:") &&
          (rule.port === undefined ||
            Number(u.port || (u.protocol === "https:" ? 443 : 80)) ===
              rule.port) &&
          hostnameMatches(rule.hostnameRegex, u.hostname),
    )
  )
    throw new Error("Target URL outside allowed environment");
  return u.toString();
}
export function resolve(
  b: Binding,
  vars: Record<string, unknown>,
  auth: Record<string, string> = {},
  data: Record<string, unknown> = {},
): unknown {
  switch (b.source) {
    case "TEST_DATA":
      if (!Object.hasOwn(data, b.name))
        throw new Error(`Missing test data ${b.name}`);
      return structuredClone(data[b.name]);
    case "STATIC":
      return b.value;
    case "RESPONSE_VARIABLE":
      if (!(b.name in vars)) throw new Error(`Missing variable ${b.name}`);
      if (b.expectedType && valueKind(vars[b.name]) !== b.expectedType)
        throw new Error(
          `Variable type mismatch: ${b.name} expected ${b.expectedType}`,
        );
      return vars[b.name];
    case "ENVIRONMENT_VARIABLE":
      if (!process.env[b.name])
        throw new Error(`Missing environment variable ${b.name}`);
      return process.env[b.name];
    case "RUNTIME_GENERATED":
      return b.kind === "uuid" ? randomUUID() : String(Date.now());
    case "AUTH_CONTEXT":
      if (!auth[b.name])
        throw new Error(`Missing authentication value ${b.name}`);
      return auth[b.name];
    case "CLIENT_MANAGED":
      return undefined;
    default:
      throw new Error("Unresolved header requires review");
  }
}
export function validate(
  c: TestCase,
  p: Plan,
  assets: Asset[],
  env: Environment,
  approved = false,
): string[] {
  const errors: string[] = [];
  try {
    caseSchema.parse(c);
    planSchema.parse(p);
    assets.forEach((a) => assetSchema.parse(a));
  } catch (e) {
    return [String(e)];
  }
  if (
    c.caseId !== p.caseId ||
    c.version !== p.caseVersion ||
    !c.planVersions.includes(p.version)
  )
    errors.push("Case/Plan version mismatch");
  if (approved && (c.status !== "APPROVED" || p.status !== "APPROVED"))
    errors.push("Only approved versions may execute");
  if (approved && c.steps.some((s) => s.review !== "CONFIRMED"))
    errors.push("Semantic expectations need review");
  const sem = new Set(c.steps.map((s) => s.id));
  if (sem.size !== c.steps.length) errors.push("Duplicate semantic step ID");
  try {
    ordered(c.steps);
    ordered(p.steps);
  } catch (e) {
    errors.push(String(e));
  }
  try {
    allowedURL(env.baseURL, env);
  } catch (e) {
    errors.push(String(e));
  }
  if (p.environmentRef !== env.id)
    errors.push("Environment reference mismatch");
  for (const action of p.uiActions)
    if (
      action.type === "fill" &&
      /password|token|secret/i.test(action.target) &&
      !action.secretRef
    )
      errors.push("Sensitive UI input requires secret reference");
  const byId = new Map(p.steps.map((s) => [s.id, s]));
  function ancestors(id: string, seen = new Set<string>()): Set<string> {
    if (seen.has(id)) return seen;
    seen.add(id);
    byId.get(id)?.dependsOn.forEach((d) => ancestors(d, seen));
    return seen;
  }
  const producers = new Map<string, string>();
  for (const s of p.steps)
    for (const name of Object.keys(s.extract)) {
      if (producers.has(name)) errors.push(`Duplicate variable ${name}`);
      producers.set(name, s.id);
    }
  for (const s of p.steps) {
    const a = assets.find(
      (a) => a.apiId === s.apiId && a.version === (s.apiVersion ?? 1),
    );
    if (!sem.has(s.semanticStepRef))
      errors.push(`Invalid semanticStepRef ${s.id}`);
    if (!a || !a.validated) errors.push(`Unvalidated API Asset ${s.apiId}`);
    if (a) {
      if (
        s.parallelSafe &&
        (s.phase !== "API" ||
          a.risk !== "READ" ||
          a.operationType !== "READ" ||
          !["GET", "HEAD"].includes(a.method))
      )
        errors.push(`Unsafe parallel step ${s.id}`);
      if (a.risk !== "READ" && !env.allowWrites)
        errors.push("Writes forbidden");
      if (a.risk === "HIGH" && !env.allowHighRisk)
        errors.push("High risk forbidden");
      if (a.risk !== "READ" && s.retries) errors.push("Unsafe write retries");
      if (a.operationType === "DELETE" && !s.requiresOwnership)
        errors.push("Delete requires run ownership");
      const params = [...a.pathTemplate.matchAll(/\{(\w+)\}/g)].map(
        (x) => x[1],
      );
      for (const k of params)
        if (!s.path[k]) errors.push(`Missing path parameter ${k}`);
      for (const [k, b] of Object.entries(s.path))
        if (
          b.source === "STATIC" &&
          a.parameters[k] &&
          typeof b.value !== a.parameters[k]
        )
          errors.push(`Parameter type mismatch ${k}`);
    }
    for (const dep of s.dependsOn) {
      const producer = byId.get(dep);
      if (producer && s.phase !== "CLEANUP" && producer.phase === "CLEANUP")
        errors.push("Business steps cannot depend on cleanup");
      if (producer && s.phase === "SETUP" && producer.phase === "API")
        errors.push("Setup cannot depend on business steps");
    }
    for (const b of [
      ...Object.values(s.path),
      ...Object.values(s.query),
      ...Object.values(s.headers),
      ...Object.values(s.bodyBindings ?? {}),
      ...(s.body ? [s.body] : []),
    ]) {
      if (
        b.source === "TEST_DATA" &&
        !Object.hasOwn(p.parameters ?? {}, b.name)
      )
        errors.push(`Undeclared test data parameter: ${b.name}`);
      if (b.source === "MANUAL_REVIEW") errors.push("Unresolved header");
      if (b.source === "RESPONSE_VARIABLE") {
        const producer = producers.get(b.name);
        if (b.fromStep && b.fromStep !== producer)
          errors.push(`Variable producer mismatch: ${b.name}`);
        const producerType = producer
          ? byId.get(producer)?.extractTypes?.[b.name]
          : undefined;
        if (b.expectedType && producerType && b.expectedType !== producerType)
          errors.push(`Variable type mismatch: ${b.name}`);
        if (!producer || producer === s.id || !ancestors(s.id).has(producer))
          errors.push(`Variable source is not a dependency: ${b.name}`);
      }
    }
    for (const path of Object.values(s.extract)) {
      try {
        atPath({}, path);
      } catch (error) {
        errors.push(String(error));
      }
    }
    for (const name of Object.keys(s.extractTypes ?? {}))
      if (!(name in s.extract))
        errors.push(`Typed extraction missing: ${name}`);
    for (const path of Object.keys(s.bodyBindings ?? {})) {
      try {
        setAtPath({}, path, null);
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (new Set(s.resourceLocks ?? []).size !== (s.resourceLocks ?? []).length)
      errors.push(`Duplicate resource lock ${s.id}`);
    if (s.phase !== "CLEANUP")
      for (const dependency of c.steps.find(
        (item) => item.id === s.semanticStepRef,
      )?.dependsOn ?? []) {
        if (
          ![...ancestors(s.id)].some(
            (id) => id !== s.id && byId.get(id)?.semanticStepRef === dependency,
          )
        )
          errors.push(
            `Semantic dependency not enforced: ${s.id} -> ${dependency}`,
          );
      }
    for (const [name, b] of Object.entries(s.headers)) {
      if (sensitive.test(name) && b.source === "STATIC")
        errors.push("Static credentials forbidden");
      if (
        ["host", "content-length", "cookie"].includes(name.toLowerCase()) &&
        b.source !== "CLIENT_MANAGED"
      )
        errors.push("Protocol header must be client managed");
    }
    if (
      s.body?.source === "STATIC" &&
      JSON.stringify(redact(s.body.value)) !== JSON.stringify(s.body.value)
    )
      errors.push("Sensitive static body must use a runtime reference");
    for (const a of s.assertions) {
      if (
        a.dataRef &&
        (!Object.hasOwn(p.parameters ?? {}, a.dataRef) || a.operator !== "eq")
      )
        errors.push(`Invalid assertion data parameter: ${a.dataRef}`);
      if (
        a.kind === "status" &&
        a.dataRef &&
        p.parameters?.[a.dataRef] !== "number"
      )
        errors.push("Status data parameter must be a number");
      if (
        !a.dataRef &&
        a.kind === "status" &&
        (a.operator !== "eq" ||
          typeof a.value !== "number" ||
          !Number.isInteger(a.value) ||
          a.value < 100 ||
          a.value > 599)
      )
        errors.push("Status assertion must compare an HTTP status");
      if (
        a.kind === "json" &&
        a.operator === "eq" &&
        !a.dataRef &&
        a.value === undefined
      )
        errors.push("JSON equality requires expected value");
      if (a.kind === "json" && !a.path)
        errors.push("JSON assertion requires path");
      try {
        if (a.path) atPath({}, a.path);
      } catch (e) {
        errors.push(String(e));
      }
      if (approved && !a.confirmed) errors.push("Assertion requires review");
    }
    if (
      s.requiresOwnership &&
      (!s.resourceVariable ||
        (s.path &&
          !Object.values(s.path).some(
            (b) =>
              b.source === "RESPONSE_VARIABLE" && b.name === s.resourceVariable,
          )))
    )
      errors.push("Ownership binding required");
    if (
      s.ownsResource &&
      (!s.resourceVariable || !s.extract[s.resourceVariable])
    )
      errors.push("Owned resource requires extraction");
    if (
      s.phase === "SETUP" &&
      s.ownsResource &&
      !p.steps.some(
        (x) =>
          x.phase === "CLEANUP" && x.resourceVariable === s.resourceVariable,
      )
    )
      errors.push("Fixture requires cleanup");
  }
  return [...new Set(errors)];
}

// Validate the entire dataset before any browser or request is started.
export function validateDataset(plan: Plan, dataset: Dataset): void {
  if (dataset.planId !== plan.planId || dataset.planVersion !== plan.version)
    throw new Error("Dataset plan/version mismatch");
  for (const row of dataset.rows) {
    for (const [name, type] of Object.entries(plan.parameters ?? {})) {
      if (
        !Object.hasOwn(row.values, name) ||
        valueKind(row.values[name]) !== type
      )
        throw new Error(
          `Dataset row ${row.id}: missing or invalid parameter ${name} (${type})`,
        );
    }
    for (const name of Object.keys(row.values))
      if (!Object.hasOwn(plan.parameters ?? {}, name))
        throw new Error(`Dataset row ${row.id}: undeclared parameter ${name}`);
    for (const step of plan.steps)
      for (const assertion of step.assertions)
        if (assertion.kind === "status" && assertion.dataRef) {
          const status = row.values[assertion.dataRef];
          if (
            typeof status !== "number" ||
            !Number.isInteger(status) ||
            status < 100 ||
            status > 599
          )
            throw new Error(`Dataset row ${row.id}: invalid HTTP status`);
        }
  }
}
