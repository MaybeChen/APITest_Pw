import { schedule } from "./scheduler.js";
import { existsSync } from "node:fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  TestCase,
  Plan,
  Asset,
  AuthProfile,
  Environment,
  Report,
  StepResult,
  Dataset,
} from "../../contracts/src/index.js";
import {
  allowedURL,
  atPath,
  ordered,
  redact,
  resolve,
  validate,
  setAtPath,
  valueKind,
  validateDataset,
} from "../../core/src/index.js";
export async function uiAuthenticate(
  context: BrowserContext,
  page: Page,
  profile: AuthProfile,
  env: Environment,
) {
  if (profile.environmentRef && profile.environmentRef !== env.id)
    throw new Error("UI flow environment mismatch");
  for (const action of profile.actions) {
    switch (action.type) {
      case "navigate":
        await page.goto(
          allowedURL(new URL(action.target, env.baseURL).href, env),
        );
        break;
      case "fill": {
        const value = action.secretRef
          ? process.env[action.secretRef]
          : action.value;
        if (value === undefined)
          throw new Error(`Missing UI input reference ${action.secretRef}`);
        await page.locator(action.target).fill(value);
        break;
      }
      case "selectOption": {
        const value = action.secretRef
          ? process.env[action.secretRef]
          : action.value;
        if (value === undefined)
          throw new Error(`Missing UI input reference ${action.secretRef}`);
        await page.locator(action.target).selectOption(value);
        break;
      }
      case "press":
        if (!action.value) throw new Error("Missing UI key");
        await page.locator(action.target).press(action.value);
        break;
      case "click":
        await page.locator(action.target).click();
        break;
      case "waitForURL":
        await page.waitForURL(action.target);
        break;
      case "waitForSelector":
      case "assertVisible":
        await page.locator(action.target).waitFor({ state: "visible" });
        break;
    }
  }
  await page.locator(profile.readySelector).waitFor({ state: "visible" });
  const auth: Record<string, string> = {};
  for (const [name, source] of Object.entries(profile.tokenSources)) {
    const value = await page.evaluate(
      (key) => localStorage.getItem(key),
      source.storageKey,
    );
    if (!value) throw new Error(`Missing localStorage auth source ${name}`);
    auth[name] = (source.prefix ?? "") + value;
  }
  return auth;
}
export class FixtureManager {
  resources: Report["resources"] = [];
  constructor(public runId: string) {}
  register(id: unknown, variable: string) {
    this.resources.push({
      id: String(id),
      variable,
      owner: this.runId,
      cleaned: false,
    });
  }
  assertOwned(id: unknown, variable: string) {
    if (
      !this.resources.some(
        (r) =>
          r.id === String(id) &&
          r.variable === variable &&
          r.owner === this.runId,
      )
    )
      throw new Error("Resource is not owned by this run");
  }
  cleaned(id: unknown) {
    for (const r of this.resources) if (r.id === String(id)) r.cleaned = true;
  }
}
export async function run(
  c: TestCase,
  p: Plan,
  assets: Asset[],
  env: Environment,
  authProfile: AuthProfile,
  testData: Record<string, unknown> = {},
): Promise<Report> {
  const errors = validate(c, p, assets, env, true);
  if (errors.length) throw new Error(errors.join("; "));
  if (p.authProfileRef !== authProfile.id)
    throw new Error("Auth profile mismatch");
  validateDataset(p, {
    id: "single",
    name: "single",
    version: 1,
    planId: p.planId,
    planVersion: p.version,
    rows: [{ id: "single", name: "single", values: testData }],
  });
  const report: Report = {
    semanticSteps: structuredClone(c.steps),
    environmentSnapshot: structuredClone(env),
    authProfileRef: authProfile.id,
    id: randomUUID(),
    caseId: c.caseId,
    caseVersion: c.version,
    planId: p.planId,
    planVersion: p.version,
    startedAt: Date.now(),
    endedAt: 0,
    status: "FAILED",
    auth: { status: "PENDING" },
    steps: [],
    resources: [],
    cleanupStatus: "PENDING",
    residualResources: [],
  };
  const fixtures = new FixtureManager(report.id),
    vars: Record<string, unknown> = {};
  let context: BrowserContext | undefined;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: process.env.RUN_HEADLESS !== "false",
      executablePath:
        process.env.CHROMIUM_PATH ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    });
    context = await browser.newContext({
      ignoreHTTPSErrors: env.ignoreHTTPSErrors ?? false,
    });
    await context.route("**/*", async (route) => {
      try {
        allowedURL(route.request().url(), env);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    let auth = await uiAuthenticate(context, page, authProfile, env);
    report.auth.status = "READY";
    // Approved preconditions use the same declarative interpreter.
    if (p.uiActions.length)
      auth = await uiAuthenticate(
        context,
        page,
        { ...authProfile, actions: p.uiActions },
        env,
      );
    let stopped = false;
    const execute = async (step: Plan["steps"][number]) => {
      const result: StepResult = {
        stepId: step.id,
        semanticStepRef: step.semanticStepRef,
        phase: step.phase,
        status: "FAILED",
        startedAt: Date.now(),
        endedAt: 0,
        attempts: 0,
        assertions: [],
      };
      const dependencyFailed = step.dependsOn.some(
        (d) => report.steps.find((s) => s.stepId === d)?.status !== "PASSED",
      );
      if ((stopped || dependencyFailed) && step.phase !== "CLEANUP") {
        result.status = "SKIPPED";
        result.error = "Dependency failed or run stopped";
        result.endedAt = Date.now();
        report.steps.push(result);
        return;
      }
      try {
        const a = assets.find(
          (a) => a.apiId === step.apiId && a.version === (step.apiVersion ?? 1),
        )!;
        let path = a.pathTemplate;
        for (const [key, b] of Object.entries(step.path))
          path = path.replace(
            `{${key}}`,
            encodeURIComponent(String(resolve(b, vars, auth, testData))),
          );
        const url = new URL(path, env.baseURL);
        for (const [k, b] of Object.entries(step.query))
          url.searchParams.set(k, String(resolve(b, vars, auth, testData)));
        allowedURL(url.href, env);
        if (step.requiresOwnership)
          fixtures.assertOwned(
            vars[step.resourceVariable!],
            step.resourceVariable!,
          );
        const headers: Record<string, string> = {};
        for (const [k, b] of Object.entries({
          ...authProfile.headers,
          ...step.headers,
        })) {
          const value = resolve(b, vars, auth, testData);
          if (value !== undefined) headers[k] = String(value);
        }
        let body = step.body
          ? resolve(step.body, vars, auth, testData)
          : undefined;
        for (const [path, binding] of Object.entries(step.bodyBindings ?? {}))
          body = setAtPath(body, path, resolve(binding, vars, auth, testData));
        result.request = redact({
          url: url.href,
          method: a.method,
          headers,
          body,
        });
        for (let attempt = 0; attempt <= step.retries; attempt++) {
          result.attempts++;
          const response = await context!.request.fetch(url.href, {
            method: a.method,
            headers,
            ...(body === undefined
              ? {}
              : step.bodyType === "form"
                ? { form: body as Record<string, string> }
                : { data: body }),
            timeout: step.timeoutMs,
            maxRedirects: 0,
          });
          if (response.status() === 401) {
            if (
              a.risk === "READ" &&
              authProfile.reauthenticateReads &&
              attempt < step.retries
            ) {
              auth = await uiAuthenticate(context!, page, authProfile, env);
              for (const [k, b] of Object.entries({
                ...authProfile.headers,
                ...step.headers,
              })) {
                const value = resolve(b, vars, auth, testData);
                if (value !== undefined) headers[k] = String(value);
              }
              continue;
            }
            result.status = "AUTH_ERROR";
            throw new Error("Authentication expired; no unsafe request replay");
          }
          const declaredLength = Number(
            response.headers()["content-length"] ?? 0,
          );
          if (declaredLength > 1048576)
            throw new Error("Runner response limit exceeded");
          if (
            !response.headers()["content-length"] &&
            ![204, 304].includes(response.status())
          )
            throw new Error(
              "Response requires a bounded Content-Length for safe capture",
            );
          const bytes = await response.body();
          if (bytes.length > 1048576)
            throw new Error("Runner response limit exceeded");
          let data: unknown;
          try {
            data = JSON.parse(bytes.toString());
          } catch {
            data = "[NON-JSON RESPONSE OMITTED]";
          }
          result.response = redact({
            status: response.status(),
            headers: response.headers(),
            body: data,
          });
          // Register fixture IDs before assertions so failed setup still gets cleaned up.
          for (const [name, path] of Object.entries(step.extract)) {
            const value = atPath(data, path);
            if (value === undefined)
              throw new Error(`Extraction missing: ${name}`);
            if (
              step.extractTypes?.[name] &&
              valueKind(value) !== step.extractTypes[name]
            )
              throw new Error(`Extraction type mismatch: ${name}`);
            vars[name] = value;
            if (step.ownsResource && name === step.resourceVariable)
              fixtures.register(value, name);
          }
          result.assertions = step.assertions.map((assertion) => {
            const actual =
              assertion.kind === "status"
                ? response.status()
                : atPath(data, assertion.path!);
            const expected = assertion.dataRef
              ? testData[assertion.dataRef]
              : assertion.value;
            return {
              expected: redact({ ...assertion, value: expected }),
              actual: redact(actual),
              passed:
                assertion.operator === "exists"
                  ? actual !== undefined
                  : assertion.operator === "notExists"
                    ? actual === undefined
                    : isDeepStrictEqual(actual, expected),
            };
          });
          if (result.assertions.every((a) => a.passed)) {
            result.status = "PASSED";
            if (a.operationType === "DELETE" && step.resourceVariable)
              fixtures.cleaned(vars[step.resourceVariable]);
            break;
          }
          if (attempt === step.retries) throw new Error("Assertion failed");
        }
      } catch (e) {
        result.error = String(redact(String(e)));
        if (step.failurePolicy === "STOP" && step.phase !== "CLEANUP")
          stopped = true;
      } finally {
        result.endedAt = Date.now();
        report.steps.push(result);
      }
    };
    const steps = ordered(p.steps);
    try {
      await schedule(
        steps.filter((s) => s.phase !== "CLEANUP"),
        assets,
        p.execution?.maxConcurrency ?? 1,
        execute,
        !authProfile.reauthenticateReads,
      );
    } finally {
      for (const step of steps.filter((s) => s.phase === "CLEANUP"))
        await execute(step);
    }
  } catch (e) {
    report.auth = { status: "FAILED", error: String(redact(String(e))) };
  } finally {
    await context?.close();
    await browser?.close();
    report.resources = fixtures.resources;
    report.residualResources = fixtures.resources
      .filter((r) => !r.cleaned)
      .map((r) => r.id);
    report.cleanupStatus =
      report.residualResources.length ||
      report.steps.some((s) => s.phase === "CLEANUP" && s.status !== "PASSED")
        ? "FAILED"
        : "PASSED";
    report.endedAt = Date.now();
    report.status =
      report.auth.status === "READY" &&
      report.steps.length === p.steps.length &&
      report.steps.every((s) => s.status === "PASSED") &&
      report.cleanupStatus === "PASSED"
        ? "PASSED"
        : "FAILED";
  }
  return redact(report);
}

export async function runDataset(
  c: TestCase,
  p: Plan,
  assets: Asset[],
  env: Environment,
  authProfile: AuthProfile,
  dataset: Dataset,
  save: (report: Report) => Promise<void> = async () => {},
): Promise<Report[]> {
  validateDataset(p, dataset);
  const batchId = randomUUID();
  const reports: Report[] = [];
  for (const row of dataset.rows) {
    // Each row uses a fresh browser, auth context, response variables and resource ledger.
    const report = await run(c, p, assets, env, authProfile, row.values);
    report.dataset = {
      id: dataset.id,
      version: dataset.version,
      rowId: row.id,
      rowName: row.name,
    };
    report.batchId = batchId;
    await save(report);
    reports.push(report);
  }
  return reports;
}
