import { expect, it } from "vitest";
import { compileCallIntent } from "../../packages/planner/src/intent-compiler";
import {
  dataCandidates,
  parameterizeRecordedInputs,
  validatePlanData,
} from "../../packages/planner/src/evidence";
import { demoApp } from "../../apps/demo-app/src/app";
import { demoAuth } from "../../apps/server/src/demo";
import { runDataset } from "../../packages/runner/src/index";
import { intentFixture } from "../fixtures/intent";
import type { Dataset } from "../../packages/contracts/src/index";

it("runs compiled intent with a fresh resource and conditionally cleans it after business failure", async () => {
  const demo = demoApp();
  await demo.listen({ host: "127.0.0.1", port: 3100 });
  const previous = process.env.DEMO_PASSWORD;
  process.env.DEMO_PASSWORD = "demo-only";
  try {
    for (const mode of ["success", "status-failure", "non-array-negative"]) {
      const fail = mode !== "success";
      const f = intentFixture();
      if (mode === "status-failure")
        f.intent.calls[1].checks = [
          { kind: "status", operator: "eq", value: 500 },
        ];
      const output = compileCallIntent(f.intent, f.context);
      expect(output.issues).toEqual([]);
      if (mode === "non-array-negative")
        output.plan.steps[1].assertions.push({
          kind: "json",
          path: "$.name",
          operator: "notContains",
          value: "missing",
          basis: "USER",
          confirmed: true,
        });
      const candidates = dataCandidates(f.recording, f.catalog);
      const plan = parameterizeRecordedInputs(output.plan, candidates, {
        recording: f.recording,
        catalog: f.catalog,
        allowSuggestions: true,
      });
      plan.status = f.testCase.status = "APPROVED";
      f.testCase.steps.forEach((step) => (step.review = "CONFIRMED"));
      plan.steps.forEach((step) =>
        step.assertions.forEach((assertion) => (assertion.confirmed = true)),
      );
      plan.dataPolicy = "REVIEW_REQUIRED";
      const dataset: Dataset = {
        id: "compiled-data",
        name: "compiled",
        planId: plan.planId,
        planVersion: plan.version,
        version: 1,
        review: {
          confirmed: true,
          sources: Object.fromEntries(
            Object.keys(plan.parameters ?? {}).map((name) => [
              name,
              "RECORDING",
            ]),
          ),
        },
        rows: [
          {
            id: "recorded",
            name: "recorded",
            values: validatePlanData(plan, candidates),
          },
        ],
      };
      const [report] = await runDataset(
        f.testCase,
        plan,
        f.assets,
        f.context.environment,
        demoAuth,
        dataset,
      );
      expect(report.status).toBe(fail ? "FAILED" : "PASSED");
      expect(report.resources).toHaveLength(1);
      expect(report.resources[0].id).not.toBe("recorded-id");
      expect(report.residualResources).toEqual([]);
      expect(report.cleanupStatus).toBe("PASSED");
      expect(
        report.steps.find((step) => step.stepId === "cleanup_delete")?.attempts,
      ).toBe(fail ? 1 : 0);
    }
  } finally {
    if (previous === undefined) delete process.env.DEMO_PASSWORD;
    else process.env.DEMO_PASSWORD = previous;
    await demo.close();
  }
}, 30000);
