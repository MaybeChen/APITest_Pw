import { describe, it, expect } from "vitest";
import {
  redact,
  ordered,
  validate,
  resolve,
  atPath,
  allowedURL,
} from "../../packages/core/src/index";
import { demoArtifacts, demoEnv } from "../../apps/server/src/demo";
import { analyze } from "../../packages/recorder/src/index";
import { generate, MockAIProvider } from "../../packages/planner/src/index";
import { FixtureManager } from "../../packages/runner/src/index";
import type { Recording } from "../../packages/contracts/src/index";
const approved = () => {
  const b = demoArtifacts();
  b.testCase.status = "APPROVED";
  b.testCase.steps.forEach((s) => (s.review = "CONFIRMED"));
  b.plan.status = "APPROVED";
  b.plan.steps.forEach((s) =>
    s.assertions.forEach((a) => (a.confirmed = true)),
  );
  return b;
};
describe("redaction and binding", () => {
  it("removes nested credentials and URL tokens", () => {
    expect(
      JSON.stringify(
        redact({
          password: "abc",
          headers: { authorization: "Bearer xyz", cookie: "s=xx" },
          url: "https://site/?token=secret",
          body: { csrfToken: "xyz" },
        }),
      ),
    ).not.toMatch(/abc|Bearer|s=xx|=secret|xyz/);
  });
  it("preserves declarative auth sources", () =>
    expect(
      redact({ Authorization: { source: "AUTH_CONTEXT", name: "bearer" } }),
    ).toEqual({ Authorization: { source: "AUTH_CONTEXT", name: "bearer" } }));
  it("refuses unknown variables and prototype access", () => {
    expect(() =>
      resolve({ source: "RESPONSE_VARIABLE", name: "unknown" }, {}),
    ).toThrow();
    expect(() => atPath({}, "$.constructor")).toThrow();
    expect(atPath({ a: [{ b: 2 }] }, "$.a[0].b")).toBe(2);
  });
  it("rejects outside origins and credentials in URLs", () => {
    expect(() => allowedURL("https://evil.test", demoEnv)).toThrow();
    expect(() =>
      allowedURL("http://user:pw@127.0.0.1:3100", demoEnv),
    ).toThrow();
  });
});
describe("plan validator", () => {
  it("accepts approved contract fixture", () => {
    const b = approved();
    expect(validate(b.testCase, b.plan, b.assets, demoEnv, true)).toEqual([]);
  });
  it("rejects unreviewed expectations", () => {
    const b = demoArtifacts();
    expect(
      validate(b.testCase, b.plan, b.assets, demoEnv, true).join(),
    ).toContain("approved");
  });
  it.each([
    "version",
    "cycle",
    "semantic",
    "asset",
    "variable",
    "retry",
    "ownership",
    "header",
    "type",
  ])("rejects invalid %s", (kind) => {
    const b = approved();
    const s = b.plan.steps[1];
    switch (kind) {
      case "version":
        b.plan.caseVersion++;
        break;
      case "cycle":
        b.plan.steps[0].dependsOn = ["verify"];
        break;
      case "semantic":
        s.semanticStepRef = "missing";
        break;
      case "asset":
        s.apiId = "missing";
        break;
      case "variable":
        s.path.id = { source: "RESPONSE_VARIABLE", name: "missing" };
        break;
      case "retry":
        b.plan.steps[0].retries = 1;
        break;
      case "ownership":
        b.plan.steps[2].requiresOwnership = false;
        break;
      case "header":
        s.headers.Authorization = { source: "STATIC", value: "sensitive" };
        break;
      case "type":
        s.path.id = { source: "STATIC", value: 123 };
        break;
    }
    expect(
      validate(b.testCase, b.plan, b.assets, demoEnv, true).length,
    ).toBeGreaterThan(0);
  });
  it("rejects missing dependencies and duplicate IDs", () => {
    expect(() => ordered([{ id: "a", dependsOn: ["no"] }])).toThrow();
    expect(() =>
      ordered([
        { id: "a", dependsOn: [] },
        { id: "a", dependsOn: [] },
      ]),
    ).toThrow();
  });
  it("tracks only owned resources", () => {
    const f = new FixtureManager("run");
    expect(() => f.assertOwned("old", "id")).toThrow();
    f.register("new", "id");
    f.assertOwned("new", "id");
    f.cleaned("new");
    expect(f.resources[0].cleaned).toBe(true);
  });
});
const recording: Recording = {
  id: "r",
  caseName: "订单查询",
  scenario: "查询订单",
  target: demoEnv.baseURL,
  notes: "",
  startedAt: 1,
  state: "STOPPED",
  operations: [],
  dependencies: [],
  redactions: [],
  requests: [
    ...["1001", "1002"].map((id, i) => ({
      id: "r" + i,
      method: "GET",
      url: demoEnv.baseURL + "/api/orders/" + id,
      resourceType: "fetch",
      startedAt: i,
      headers: {},
      query: {},
      status: 200,
      response: { id },
      initiator: "UNKNOWN" as const,
      category: "UNKNOWN" as const,
      operationCandidates: [],
    })),
    {
      id: "login",
      method: "POST",
      url: demoEnv.baseURL + "/login",
      resourceType: "fetch",
      startedAt: 0,
      headers: {},
      query: {},
      status: 200,
      initiator: "UNKNOWN",
      category: "UNKNOWN",
      operationCandidates: [],
    },
  ],
};
describe("recording analysis and planning", () => {
  it("normalizes identifiers and excludes auth", () => {
    const a = analyze(recording);
    expect(a.assets).toHaveLength(1);
    expect(a.assets[0].pathTemplate).toBe("/api/orders/{id}");
    expect(a.recording.requests[2].keep).toBe(false);
  });
  it("honors manual exclusion", () =>
    expect(
      analyze(recording, { overrides: { r0: false, r1: false } }).assets,
    ).toHaveLength(0));
  it("generates two linked unapproved artifacts without inventing business rules", async () => {
    const a = analyze(recording);
    const result = await generate(new MockAIProvider(), {
      ...a,
      environment: demoEnv,
    });
    expect(result.plan.caseId).toBe(result.testCase.caseId);
    expect(result.plan.model.provider).toBe("MockAIProvider");
    expect(result.testCase.steps[0].review).toBe("NEEDS_REVIEW");
    expect(result.plan.steps[0].assertions[0].confirmed).toBe(false);
  });
  it("limits invalid model output retries", async () => {
    let calls = 0;
    await expect(
      generate(
        {
          name: "bad",
          version: "1",
          generate: async () => {
            calls++;
            return {};
          },
        },
        { recording, assets: [], environment: demoEnv },
      ),
    ).rejects.toThrow("2 attempts");
    expect(calls).toBe(2);
  });
});
