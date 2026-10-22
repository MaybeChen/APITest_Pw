import { z } from "zod";
export const id = z.string().min(1);
export const status = z.enum(["DRAFT", "PENDING_REVIEW", "APPROVED"]);
export const evidence = z.object({
  source: z.string(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  confirmed: z.boolean().default(false),
});
export const binding = z.discriminatedUnion("source", [
  z.object({ source: z.literal("STATIC"), value: z.unknown() }),
  z.object({ source: z.literal("RESPONSE_VARIABLE"), name: id }),
  z.object({ source: z.literal("ENVIRONMENT_VARIABLE"), name: id }),
  z.object({
    source: z.literal("RUNTIME_GENERATED"),
    kind: z.enum(["uuid", "timestamp"]),
  }),
  z.object({ source: z.literal("AUTH_CONTEXT"), name: id }),
  z.object({ source: z.literal("CLIENT_MANAGED") }),
  z.object({ source: z.literal("MANUAL_REVIEW") }),
]);
export const action = z.object({
  type: z.enum([
    "navigate",
    "click",
    "fill",
    "waitForURL",
    "waitForSelector",
    "assertVisible",
  ]),
  target: id,
  value: z.string().optional(),
  secretRef: z.string().optional(),
});
export const network = z.object({
  id,
  method: id,
  url: z.string(),
  resourceType: id,
  startedAt: z.number(),
  endedAt: z.number().optional(),
  duration: z.number().optional(),
  query: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()),
  body: z.unknown().optional(),
  status: z.number().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  response: z.unknown().optional(),
  failure: z.string().optional(),
  redirectFrom: z.string().optional(),
  initiator: z.literal("UNKNOWN").default("UNKNOWN"),
  operationCandidates: z
    .array(evidence.extend({ operationId: id }))
    .default([]),
  category: z
    .enum([
      "AUTH_BOOTSTRAP",
      "BUSINESS",
      "TELEMETRY",
      "STATIC_RESOURCE",
      "UNKNOWN",
    ])
    .default("UNKNOWN"),
  classification: evidence.optional(),
  keep: z.boolean().optional(),
});
export const recordingSchema = z.object({
  id,
  workspaceId: z.string().optional(),
  caseName: id,
  scenario: id,
  target: z.string().url(),
  notes: z.string().default(""),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  state: z.enum(["RECORDING", "STOPPED"]),
  operations: z.array(
    z.object({
      id,
      type: id,
      at: z.number(),
      url: z.string(),
      context: z.record(z.string(), z.unknown()),
      requestIds: z.array(id).default([]),
    }),
  ),
  requests: z.array(network),
  dependencies: z
    .array(
      evidence.extend({
        from: id,
        to: id,
        path: id,
        value: z.unknown().optional(),
      }),
    )
    .default([]),
  redactions: z.array(z.string()).default([]),
});
export const assetSchema = z.object({
  apiId: id,
  version: z.number().int().positive(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  pathTemplate: id,
  parameters: z.record(
    z.string(),
    z.enum(["string", "number", "boolean", "object", "array", "null"]),
  ),
  requestSchema: z.record(z.string(), z.unknown()),
  responseSchema: z.record(z.string(), z.unknown()),
  headers: z.record(z.string(), binding),
  authRequired: z.boolean(),
  operationType: z.enum(["READ", "CREATE", "UPDATE", "DELETE"]),
  risk: z.enum(["READ", "WRITE", "HIGH"]),
  sources: z.array(id),
  evidence,
  validated: z.boolean(),
});
export const caseSchema = z.object({
  caseId: id,
  workspaceId: z.string().optional(),
  name: id,
  objective: id,
  version: z.number().int().positive(),
  preconditions: z.array(z.string()),
  steps: z
    .array(
      z.object({
        id,
        title: id,
        expected: id,
        dependsOn: z.array(id),
        review: z.enum(["CONFIRMED", "NEEDS_REVIEW"]),
      }),
    )
    .min(1),
  expected: id,
  planVersions: z.array(z.number().int().positive()),
  status,
});
export const assertion = z.object({
  kind: z.enum(["status", "json"]),
  path: z.string().optional(),
  operator: z.enum(["eq", "exists", "notExists"]),
  value: z.unknown().optional(),
  basis: z.enum(["CONTRACT", "RECORDING", "USER"]),
  confirmed: z.boolean(),
});
export const stepSchema = z.object({
  id,
  semanticStepRef: id,
  apiId: id,
  apiVersion: z.number().int().positive().optional(),
  phase: z.enum(["SETUP", "API", "CLEANUP"]),
  dependsOn: z.array(id),
  path: z.record(z.string(), binding),
  query: z.record(z.string(), binding),
  body: binding.optional(),
  bodyType: z.enum(["json", "form"]).default("json"),
  headers: z.record(z.string(), binding),
  extract: z.record(z.string(), z.string()),
  assertions: z.array(assertion).min(1),
  timeoutMs: z.number().int().min(100).max(120000),
  retries: z.number().int().min(0).max(2),
  failurePolicy: z.enum(["STOP", "CONTINUE"]),
  ownsResource: z.boolean().default(false),
  resourceVariable: z.string().optional(),
  requiresOwnership: z.boolean().default(false),
});
export const planSchema = z.object({
  planId: id,
  caseId: id,
  caseVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  status,
  environmentRef: id,
  policyRef: id,
  authProfileRef: id,
  uiActions: z.array(action),
  steps: z.array(stepSchema).min(1),
  cleanupPolicy: z.literal("ALWAYS"),
  model: z.object({ provider: id, version: id }),
  generatedAt: z.number(),
});
export const authSchema = z.object({
  id,
  actions: z.array(action),
  readySelector: id,
  headers: z.record(z.string(), binding).default({}),
  tokenSources: z
    .record(
      z.string(),
      z.object({ storageKey: id, prefix: z.string().default("") }),
    )
    .default({}),
  reauthenticateReads: z.boolean().default(false),
});
export const environmentSchema = z.object({
  id,
  baseURL: z.string().url(),
  allowedOrigins: z.array(z.string().url()).min(1),
  allowWrites: z.boolean(),
  allowHighRisk: z.boolean().default(false),
});
export type Recording = z.infer<typeof recordingSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type TestCase = z.infer<typeof caseSchema>;
export type Plan = z.infer<typeof planSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Binding = z.infer<typeof binding>;
export type AuthProfile = z.infer<typeof authSchema>;
export type Environment = z.infer<typeof environmentSchema>;
export interface StepResult {
  stepId: string;
  semanticStepRef: string;
  phase: string;
  status: "PASSED" | "FAILED" | "SKIPPED" | "AUTH_ERROR";
  startedAt: number;
  endedAt: number;
  attempts: number;
  request?: unknown;
  response?: unknown;
  assertions: { expected: unknown; actual: unknown; passed: boolean }[];
  error?: string;
}
export interface Report {
  semanticSteps?: TestCase["steps"];
  environmentSnapshot?: Environment;
  authProfileRef?: string;
  id: string;
  caseId: string;
  caseVersion: number;
  planId: string;
  planVersion: number;
  startedAt: number;
  endedAt: number;
  status: "PASSED" | "FAILED";
  auth: { status: string; error?: string };
  steps: StepResult[];
  resources: {
    id: string;
    owner: string;
    variable: string;
    cleaned: boolean;
  }[];
  cleanupStatus: string;
  residualResources: string[];
}
