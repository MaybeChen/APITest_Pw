import { expect, it } from "vitest";
import { createApp } from "../../apps/server/src/app";
import { Store } from "../../packages/storage/src/index";
import { MockAIProvider } from "../../packages/planner/src/index";
import { demoArtifacts } from "../../apps/server/src/demo";
import type { Dataset } from "../../packages/contracts/src/index";

it("copies compatible datasets atomically when approving a new plan version and retains old data", async () => {
  const store = new Store("file::memory:");
  const app = await createApp(store, new MockAIProvider());
  try {
    const original = demoArtifacts("inherit-case");
    original.testCase.steps.forEach((step) => {
      step.review = "CONFIRMED";
    });
    original.plan.steps.forEach((step) =>
      step.assertions.forEach((assertion) => {
        assertion.confirmed = true;
      }),
    );
    original.plan.parameters = { input: "object" };
    original.plan.steps[0].body = { source: "TEST_DATA", name: "input" };
    const approved = await app.inject({
      method: "POST",
      url: "/api/approve",
      payload: { ...original, confirmed: true },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const dataset: Dataset = {
      id: "original-data",
      version: 1,
      name: "录制数据",
      planId: original.plan.planId,
      planVersion: 1,
      rows: [
        {
          id: "first",
          name: "第一组",
          values: { input: { name: "recorded" } },
        },
        {
          id: "second",
          name: "第二组",
          values: { input: { name: "alternate" } },
        },
      ],
      review: { confirmed: true, sources: { input: "USER" } },
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/datasets",
          payload: dataset,
        })
      ).statusCode,
    ).toBe(200);
    const next = structuredClone(original);
    next.testCase.version = next.plan.caseVersion = next.plan.version = 2;
    next.testCase.planVersions = [2];
    next.plan.authProfileRef = "different-ui";
    const response = await app.inject({
      method: "POST",
      url: "/api/approve",
      payload: { ...next, confirmed: true },
    });
    expect(response.statusCode, response.body).toBe(200);
    const datasets = (await app.inject("/api/datasets")).json() as Dataset[];
    const copy = datasets.find((item) => item.planVersion === 2)!;
    expect(copy).toBeDefined();
    expect(copy.id).not.toBe(dataset.id);
    expect(copy.rows).toEqual(dataset.rows);
    expect(copy.review).toEqual(dataset.review);
    expect(await store.get("dataset", dataset.id, 1)).toEqual(dataset);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/approve",
          payload: { ...next, confirmed: true },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject("/api/datasets")).json()).toHaveLength(2);
    const third = structuredClone(next);
    third.testCase.version = third.plan.caseVersion = third.plan.version = 3;
    third.testCase.planVersions = [3];
    third.plan.parameters!.input = "string";
    const incompatible = await app.inject({
      method: "POST",
      url: "/api/approve",
      payload: { ...third, confirmed: true },
    });
    expect(incompatible.statusCode, incompatible.body).toBe(200);
    expect(
      ((await app.inject("/api/datasets")).json() as Dataset[]).some(
        (item) => item.planVersion === 3,
      ),
    ).toBe(false);
    const fourth = structuredClone(third);
    fourth.testCase.version = fourth.plan.caseVersion = fourth.plan.version = 4;
    fourth.testCase.planVersions = [4];
    fourth.plan.parameters!.input = "object";
    fourth.plan.dataRequirements = {
      input: { source: "USER", apiId: "create", location: "BODY", path: "$" },
    };
    const recovered = await app.inject({
      method: "POST",
      url: "/api/approve",
      payload: { ...fourth, confirmed: true },
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    const recoveredData = (
      (await app.inject("/api/datasets")).json() as Dataset[]
    ).find((item) => item.planVersion === 4)!;
    expect(recoveredData.rows).toEqual(dataset.rows);
    expect(recoveredData.review?.confirmed).toBe(false);
  } finally {
    await app.close();
  }
});
