import { describe, it, expect } from "vitest";
import {
  redact,
  ordered,
  validate,
  resolve,
  atPath,
  allowedURL,
  shouldCaptureRequest,
} from "../../packages/core/src/index";
import { demoArtifacts, demoEnv } from "../../apps/server/src/demo";
import { analyze } from "../../packages/recorder/src/index";
import { generate, MockAIProvider } from "../../packages/planner/src/index";
import { FixtureManager } from "../../packages/runner/src/index";
import type { Recording } from "../../packages/contracts/src/index";
import { environmentSchema } from "../../packages/contracts/src/index";
it("defaults TLS verification to enabled and requires an explicit per-environment opt-in", () => {
  const { ignoreHTTPSErrors: _ignored, ...legacy } = demoEnv;
  expect(environmentSchema.parse(legacy).ignoreHTTPSErrors).toBe(false);
  expect(
    environmentSchema.parse({ ...legacy, ignoreHTTPSErrors: true })
      .ignoreHTTPSErrors,
  ).toBe(true);
  expect(
    environmentSchema.safeParse({ ...legacy, ignoreHTTPSErrors: "true" })
      .success,
  ).toBe(false);
  expect(demoEnv.ignoreHTTPSErrors).toBe(false);
});
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
        { ...analyze(recording), environment: demoEnv },
      ),
    ).rejects.toThrow("2 attempts");
    expect(calls).toBe(2);
  });
});

describe("hostname regex allowlist rules", () => {
  const env = environmentSchema.parse({
    ...demoEnv,
    baseURL: "https://astr-lab.gts.huawei.com",
    allowedOrigins: [{ hostnameRegex: String.raw`(^|\.)huawei\.com$` }],
  });
  it.each([
    "https://huawei.com",
    "https://astr-lab.gts.huawei.com/wiseoffice/insight/#/topic=all",
    "https://LOGIN.HUAWEI.COM:38443/login",
  ])("permits %s", (url) => expect(() => allowedURL(url, env)).not.toThrow());
  it.each([
    "https://fakehuawei.com",
    "https://huawei.com.evil.test",
    "https://evil.test/huawei.com",
    "https://evil.test/?next=huawei.com",
    "http://login.huawei.com",
    "https://user:password@login.huawei.com",
  ])("rejects %s", (url) => expect(() => allowedURL(url, env)).toThrow());
  it("retains exact origin rules and supports explicit protocol and port restrictions", () => {
    expect(() => allowedURL(demoEnv.baseURL, demoEnv)).not.toThrow();
    const restricted = environmentSchema.parse({
      ...demoEnv,
      allowedOrigins: [
        { hostnameRegex: "^localhost$", protocol: "http:", port: 3100 },
      ],
    });
    expect(() =>
      allowedURL("http://localhost:3100/test", restricted),
    ).not.toThrow();
    expect(() =>
      allowedURL("http://localhost:3101/test", restricted),
    ).toThrow();
    expect(() =>
      allowedURL("https://localhost:3100/test", restricted),
    ).toThrow();
  });
  it.each(["[", "(?=huawei)", "(a)\\1"])(
    "rejects malformed or unsupported regex %s",
    (pattern) =>
      expect(
        environmentSchema.safeParse({
          ...demoEnv,
          allowedOrigins: [{ hostnameRegex: pattern }],
        }).success,
      ).toBe(false),
  );
});

describe("recording request domain whitelist", () => {
  it("retains the previous Fetch/XHR behavior when unset or empty", () => {
    for (const env of [demoEnv, { ...demoEnv, recordingRequestDomains: [] }]) {
      expect(
        shouldCaptureRequest("https://any.example.test/api", "fetch", env),
      ).toBe(true);
      expect(
        shouldCaptureRequest("https://any.example.test/api", "xhr", env),
      ).toBe(true);
      expect(
        shouldCaptureRequest("https://any.example.test/page", "document", env),
      ).toBe(false);
      expect(shouldCaptureRequest("data:text/plain,test", "fetch", env)).toBe(
        false,
      );
    }
  });
  const env = environmentSchema.parse({
    ...demoEnv,
    recordingRequestDomains: [
      "API.EXAMPLE.TEST",
      { hostnameRegex: String.raw`(^|\.)huawei\.com$` },
    ],
  });
  it.each([
    "https://api.example.test:38443/orders",
    "http://api.example.test/orders",
    "https://astr-lab.gts.huawei.com/wiseoffice",
    "https://huawei.com/api",
  ])("retains matching request %s", (url) =>
    expect(shouldCaptureRequest(url, "fetch", env)).toBe(true),
  );
  it.each([
    "https://other.example.test/api",
    "https://fakehuawei.com/api",
    "https://huawei.com.evil.test/api",
    "https://other.test/api.example.test",
    "https://other.test/?next=huawei.com",
  ])("does not retain nonmatching request %s", (url) =>
    expect(shouldCaptureRequest(url, "xhr", env)).toBe(false),
  );
  it.each([
    "https://api.example.test",
    "api.example.test:443",
    "api.example.test/path",
    "*.example.test",
  ])("rejects non-hostname entry %s", (entry) =>
    expect(
      environmentSchema.safeParse({
        ...demoEnv,
        recordingRequestDomains: [entry],
      }).success,
    ).toBe(false),
  );
  it("rejects invalid regex and leaves browser navigation permission independent", () => {
    expect(
      environmentSchema.safeParse({
        ...demoEnv,
        recordingRequestDomains: [{ hostnameRegex: "[" }],
      }).success,
    ).toBe(false);
    const recordingOnly = {
      ...demoEnv,
      recordingRequestDomains: ["localhost"],
    };
    expect(() => allowedURL(demoEnv.baseURL, recordingOnly)).not.toThrow();
    expect(
      shouldCaptureRequest(
        demoEnv.baseURL + "/api/orders",
        "fetch",
        recordingOnly,
      ),
    ).toBe(false);
  });
});

describe("planner input and nonstandard interface paths", () => {
  it.each(["/wiseoffice/insight/topics/list", "/graphql", "/business/authors"])(
    "retains %s as a review candidate",
    async (path) => {
      const source = structuredClone(recording);
      source.requests = [
        { ...source.requests[0], url: demoEnv.baseURL + path },
      ];
      const analyzed = analyze(source);
      expect(analyzed.recording.requests[0].category).toBe("UNKNOWN");
      expect(analyzed.recording.requests[0].keep).toBe(true);
      const result = await generate(new MockAIProvider(), {
        ...analyzed,
        environment: demoEnv,
      });
      expect(result.plan.steps).toHaveLength(1);
      expect(result.testCase.steps[0].review).toBe("NEEDS_REVIEW");
      expect(analyze(source, { overrides: { r0: false } }).assets).toEqual([]);
    },
  );
  it("reports missing or excluded evidence without invoking the model", async () => {
    let calls = 0;
    const provider = {
      name: "unused",
      version: "1",
      generate: async () => {
        calls++;
        throw new Error("must not be called");
      },
    };
    const empty = structuredClone(recording);
    empty.requests = [];
    await expect(
      generate(provider, {
        recording: empty,
        assets: [],
        environment: demoEnv,
      }),
    ).rejects.toThrow("没有 Fetch/XHR");
    const excluded = analyze(recording, {
      overrides: { r0: false, r1: false },
    });
    await expect(
      generate(provider, { ...excluded, environment: demoEnv }),
    ).rejects.toThrow("没有保留");
    const selected = analyze(recording);
    await expect(
      generate(provider, {
        recording: selected.recording,
        assets: [],
        environment: demoEnv,
      }),
    ).rejects.toThrow("接口资产");
    expect(calls).toBe(0);
  });
});

it.each(["/login.action", "/auth.do"])(
  "keeps legacy authentication endpoint %s excluded",
  (path) => {
    const source = structuredClone(recording);
    source.requests = [{ ...source.requests[0], url: demoEnv.baseURL + path }];
    const result = analyze(source, { overrides: { r0: true } });
    expect(result.recording.requests[0].category).toBe("AUTH_BOOTSTRAP");
    expect(result.recording.requests[0].keep).toBe(false);
    expect(result.assets).toHaveLength(0);
  },
);
