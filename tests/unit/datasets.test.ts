import { expect, it } from "vitest";
import { datasetSchema, planSchema } from "../../packages/contracts/src/index";
import {
  resolve,
  validateDataset,
  validate,
} from "../../packages/core/src/index";
import { demoArtifacts, demoEnv } from "../../apps/server/src/demo";
function fixture() {
  const bundle = demoArtifacts();
  bundle.plan.parameters = { order: "object", expectedName: "string" };
  bundle.plan.steps[0].body = { source: "TEST_DATA", name: "order" };
  bundle.plan.steps[1].assertions.push({
    kind: "json",
    path: "$.name",
    operator: "eq",
    dataRef: "expectedName",
    basis: "USER",
    confirmed: false,
  });
  const dataset = datasetSchema.parse({
    id: "orders",
    version: 1,
    name: "orders",
    planId: bundle.plan.planId,
    planVersion: 1,
    rows: [
      {
        id: "a",
        name: "a",
        values: { order: { name: "A" }, expectedName: "A" },
      },
      {
        id: "b",
        name: "b",
        values: { order: { name: "B" }, expectedName: "B" },
      },
    ],
  });
  return { ...bundle, dataset };
}
it("validates a reusable parameterized plan with separate input and expected data", () => {
  const b = fixture();
  expect(planSchema.parse(b.plan).parameters).toEqual(b.plan.parameters);
  expect(validate(b.testCase, b.plan, b.assets, demoEnv)).toEqual([]);
  expect(() => validateDataset(b.plan, b.dataset)).not.toThrow();
  expect(b.plan.steps[0].body).toEqual({ source: "TEST_DATA", name: "order" });
});
it("keeps test data separate from response variables and clones structured values", () => {
  const data = { name: { nested: [1] } };
  const value = resolve(
    { source: "TEST_DATA", name: "name" },
    { name: "response" },
    {},
    data,
  ) as typeof data.name;
  value.nested.push(2);
  expect(data.name.nested).toEqual([1]);
  expect(() =>
    resolve({ source: "TEST_DATA", name: "missing" }, { missing: 1 }),
  ).toThrow("Missing test data");
  expect(() => resolve({ source: "TEST_DATA", name: "toString" }, {})).toThrow(
    "Missing test data",
  );
});
it("rejects missing, wrong type, unknown and mismatched-version data before running", () => {
  const b = fixture();
  for (const values of [
    { expectedName: "A" },
    { order: "wrong", expectedName: "A" },
    { order: {}, expectedName: "A", typo: 1 },
  ]) {
    const data = structuredClone(b.dataset);
    data.rows[1].values = values;
    expect(() => validateDataset(b.plan, data)).toThrow("Dataset row b");
  }
  expect(() =>
    validateDataset(b.plan, { ...b.dataset, planVersion: 2 }),
  ).toThrow("mismatch");
  expect(
    datasetSchema.safeParse({
      ...b.dataset,
      rows: [b.dataset.rows[0], b.dataset.rows[0]],
    }).success,
  ).toBe(false);
  b.plan.steps[0].body = { source: "TEST_DATA", name: "undeclared" };
  expect(validate(b.testCase, b.plan, b.assets, demoEnv)).toContain(
    "Undeclared test data parameter: undeclared",
  );
});
