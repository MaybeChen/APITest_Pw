import { z } from "zod";
import {
  id,
  evidence,
  caseSchema,
  planSchema,
} from "../../contracts/src/index.js";
export const businessFlowSchema = z.object({
  summary: z.string().min(1),
  steps: z
    .array(
      z.object({
        id,
        title: id,
        requestRefs: z.array(id).min(1),
        apiRefs: z.array(id).min(1),
        dependsOn: z.array(id),
        parallelCandidate: z.boolean(),
        reason: z.string(),
        needsReview: z.boolean(),
      }),
    )
    .min(1),
  parameterCandidates: z.array(
    z.object({
      fromRequest: id,
      toRequest: id,
      responsePath: id,
      targetLocation: z.enum(["PATH", "QUERY", "BODY", "HEADER"]),
      targetKey: id,
      evidence,
    }),
  ),
  uncertainties: z.array(z.string()),
});
export const repairedSchema = z.object({
  testCase: caseSchema,
  plan: planSchema,
});
export const stageIds = [
  "EVIDENCE",
  "BUSINESS_FLOW",
  "SEMANTIC_CASE",
  "EXECUTION_PLAN",
  "VALIDATION",
  "REPAIR",
  "FINAL_VALIDATION",
] as const;
export type AIStage =
  "BUSINESS_FLOW" | "SEMANTIC_CASE" | "EXECUTION_PLAN" | "REPAIR";
export type BusinessFlow = z.infer<typeof businessFlowSchema>;
export const generationStageSchema = z.object({
  id: z.enum(stageIds),
  state: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"]),
  attempts: z.number().int().nonnegative(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  error: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
});
