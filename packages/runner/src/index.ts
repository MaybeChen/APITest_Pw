import { retainBrowser, type RetryStep } from "./retained-browsers.js";
import { withRawRequestHeaders } from "./request-headers.js";
import { snapshotCookies, compareSentCookies } from "./cookie-diagnostics.js";
import { observeAuthResponses } from "./auth-response.js";
import { observeUINetwork } from "./ui-network.js";
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
  jsonArrayContains,
  atPath,
  ordered,
  redact,
  redactReport,
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
  previousAuth?: Record<string, string>,
  allowPreviousStorage = false,
  deferMissingSources = false,
) {
  if (profile.environmentRef && profile.environmentRef !== env.id)
    throw new Error("UI flow environment mismatch");
  const responses = observeAuthResponses(context, profile, env);
  const network = observeUINetwork(context);
  const filled = new Map<string, string>();
  let inputPageReady = false;
  const navigated = () => {
    filled.clear();
    inputPageReady = false;
  };
  const onNavigation = (frame: import("playwright").Frame) => {
    if (frame === page.mainFrame()) navigated();
  };
  page.on("framenavigated", onNavigation);
  const checkFilled = async () => {
    for (const [target, expected] of filled) {
      const locator = page.locator(target);
      // Hidden fields may belong to an earlier step of a multi-page form.
      if (!(await locator.isVisible())) continue;
      const matches = await locator.evaluate(
        (element, value) =>
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
            ? element.value === value
            : element.textContent === value,
        expected,
      );
      if (!matches)
        throw new Error(
          `前置 UI 输入校验失败：${target} 的值在填写后发生变化，已停止后续操作；请检查页面初始化或重渲染`,
        );
    }
  };
  try {
    for (const action of profile.actions) {
      switch (action.type) {
        case "navigate":
          await page.goto(
            allowedURL(new URL(action.target, env.baseURL).href, env),
          );
          await network.wait();
          inputPageReady = true;
          break;
        case "fill": {
          const value = action.secretRef
            ? process.env[action.secretRef]
            : action.value;
          if (value === undefined)
            throw new Error(`Missing UI input reference ${action.secretRef}`);
          // Also covers profiles starting on an existing page or forms opened by a click.
          if (!inputPageReady) {
            await page.waitForLoadState("domcontentloaded");
            await network.wait();
            inputPageReady = true;
          }
          filled.delete(action.target);
          await checkFilled();
          await page.locator(action.target).fill(value);
          filled.set(action.target, value);
          await checkFilled();
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
          if (action.value === "Enter" && filled.size) {
            await network.wait();
            await checkFilled();
          }
          await page.locator(action.target).press(action.value);
          inputPageReady = false;
          break;
        case "click":
          if (filled.size) {
            await network.wait();
            await checkFilled();
          }
          await page.locator(action.target).click();
          inputPageReady = false;
          break;
        case "waitForURL":
          await page.waitForURL(action.target);
          await network.wait();
          inputPageReady = true;
          break;
        case "waitForSelector":
        case "assertVisible":
          await page.locator(action.target).waitFor({ state: "visible" });
          break;
      }
    }
    if (profile.readySelector?.trim())
      await page
        .locator(profile.readySelector.trim())
        .waitFor({ state: "visible" });
    await network.wait();
    const auth: Record<string, string> = {};
    for (const [name, source] of Object.entries(profile.tokenSources)) {
      const kind = source.source ?? "localStorage";
      let value: string | null | undefined;
      if (kind === "response" || kind === "responseHeader") {
        const previous = previousAuth?.[name];
        if (deferMissingSources && !previous && !responses.observed(name))
          continue;
        const prefix = source.prefix ?? "";
        value = await responses.read(
          name,
          previous?.startsWith(prefix)
            ? previous.slice(prefix.length)
            : undefined,
        );
      } else if (kind === "cookie") {
        const cookies = await context.cookies(
          allowedURL(source.url ?? env.baseURL, env),
        );
        const cookie = cookies.find(
          (cookie) => cookie.name === source.storageKey,
        );
        value = cookie?.value;
        if (value) {
          try {
            value = decodeURIComponent(value);
          } catch {
            /* Keep raw cookie when it is not URI encoded. */
          }
        }
      } else {
        if (source.origin) allowedURL(source.origin, env);
        const frame = source.origin
          ? page.frames().find((frame) => {
              try {
                return (
                  new URL(frame.url()).origin === new URL(source.origin!).origin
                );
              } catch {
                return false;
              }
            })
          : page.mainFrame();
        if (!frame) {
          if (allowPreviousStorage && previousAuth?.[name]) {
            auth[name] = previousAuth[name];
            continue;
          }
          if (deferMissingSources) continue;
          throw new Error(`Missing auth storage origin for ${name}`);
        }
        value = await frame.evaluate(
          ({ key, kind }) =>
            (kind === "sessionStorage" ? sessionStorage : localStorage).getItem(
              key,
            ),
          { key: source.storageKey, kind },
        );
      }
      if (
        !value &&
        allowPreviousStorage &&
        (kind === "localStorage" || kind === "sessionStorage") &&
        previousAuth?.[name]
      ) {
        const prefix = source.prefix ?? "";
        value = previousAuth[name].startsWith(prefix)
          ? previousAuth[name].slice(prefix.length)
          : previousAuth[name];
      }
      if (!value && deferMissingSources) continue;
      if (!value) throw new Error(`Missing ${kind} auth source ${name}`);
      auth[name] = (source.prefix ?? "") + value;
    }
    return auth;
  } finally {
    page.off("framenavigated", onNavigation);
    network.close();
    responses.close();
  }
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
  hasActive(id: unknown, variable: string) {
    return this.resources.some(
      (resource) =>
        resource.id === String(id) &&
        resource.variable === variable &&
        resource.owner === this.runId &&
        !resource.cleaned,
    );
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
  dataReview?: Dataset["review"],
): Promise<Report> {
  const errors = validate(c, p, assets, env, true);
  if (errors.length) throw new Error(errors.join("; "));
  if (p.authProfileRef !== authProfile.id)
    throw new Error("Auth profile mismatch");
  validateDataset(
    p,
    {
      review: dataReview,
      id: "single",
      name: "single",
      version: 1,
      planId: p.planId,
      planVersion: p.version,
      rows: [{ id: "single", name: "single", values: testData }],
    },
    true,
  );
  const report: Report = {
    ...(process.env.RUN_LOG_RAW_HEADERS === "true"
      ? { debug: { rawRequestHeaders: true } }
      : {}),
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
  let retryStep: RetryStep | undefined;
  try {
    const headless = process.env.RUN_HEADLESS !== "false";
    const configuredSlowMo = Number(
      process.env.RUN_SLOW_MO_MS ?? (headless ? 0 : 500),
    );
    browser = await chromium.launch({
      headless,
      slowMo:
        Number.isFinite(configuredSlowMo) && configuredSlowMo >= 0
          ? Math.min(configuredSlowMo, 5000)
          : headless
            ? 0
            : 500,
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
    let activePage = page;
    let auth = await uiAuthenticate(
      context,
      page,
      authProfile,
      env,
      undefined,
      false,
      !!p.applicationInitializations?.length,
    );
    report.auth.status = "READY";
    // Approved preconditions use the same declarative interpreter.
    if (p.uiActions.length)
      auth = await uiAuthenticate(
        context,
        page,
        { ...authProfile, actions: p.uiActions },
        env,
        auth,
        false,
        !!p.applicationInitializations?.length,
      );
    let stopped = false;
    const initialized = new Set<string>();
    const snapshots = new Map<string, Record<string, unknown>>();
    const execute = async (
      step: Plan["steps"][number],
      targetReport = report,
      manualRetry = false,
    ) => {
      const report = targetReport;
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
      if (
        step.phase === "CLEANUP" &&
        step.onlyIfOwned &&
        !fixtures.hasActive(
          vars[step.resourceVariable!],
          step.resourceVariable!,
        )
      ) {
        result.status = "PASSED";
        result.endedAt = Date.now();
        report.steps.push(result);
        return;
      }
      const dependencyFailed = step.dependsOn.some(
        (d) => report.steps.find((s) => s.stepId === d)?.status !== "PASSED",
      );
      if (
        !manualRetry &&
        (stopped || dependencyFailed) &&
        step.phase !== "CLEANUP"
      ) {
        result.status = "SKIPPED";
        result.error = "Dependency failed or run stopped";
        result.endedAt = Date.now();
        report.steps.push(result);
        return;
      }
      const asset = assets.find(
        (item) =>
          item.apiId === step.apiId && item.version === (step.apiVersion ?? 1),
      );
      result.retryable =
        step.phase === "API" &&
        !!asset &&
        ["GET", "HEAD"].includes(asset.method) &&
        asset.risk === "READ" &&
        !step.ownsResource &&
        !step.requiresOwnership;
      if (!manualRetry && result.retryable)
        snapshots.set(step.id, structuredClone(vars));
      try {
        if (!manualRetry)
          for (const initialization of p.applicationInitializations ?? []) {
            if (
              initialization.beforeStepId !== step.id ||
              initialized.has(initialization.navigationId)
            )
              continue;
            const entry: NonNullable<
              Report["applicationInitializations"]
            >[number] = {
              navigationId: initialization.navigationId,
              url: initialization.url,
              beforeStepId: step.id,
              status: "FAILED",
              startedAt: Date.now(),
              endedAt: 0,
            };
            (report.applicationInitializations ??= []).push(entry);
            try {
              const applicationPage = initialization.newWindow
                ? await context!.newPage()
                : page;
              auth = await uiAuthenticate(
                context!,
                applicationPage,
                {
                  ...authProfile,
                  actions: [{ type: "navigate", target: initialization.url }],
                  readySelector: initialization.readySelector,
                },
                env,
                auth,
                true,
              );
              if (
                /\/(?:login|dspcas)(?:\/|$)/i.test(
                  new URL(applicationPage.url()).pathname,
                )
              )
                throw new Error("应用初始化停留在登录页面");
              initialized.add(initialization.navigationId);
              activePage = applicationPage;
              entry.status = "PASSED";
            } catch (error) {
              result.retryable = false;
              snapshots.delete(step.id);
              entry.error = String(redact(String(error)));
              report.auth = { status: "FAILED", error: entry.error };
              throw error;
            } finally {
              entry.endedAt = Date.now();
            }
          }
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
        const headerBlacklist = new Set(
          (env.headerBlacklist ?? []).map((name) => name.toLowerCase()),
        );
        for (const [k, b] of Object.entries({
          ...authProfile.headers,
          ...step.headers,
        })) {
          if (headerBlacklist.has(k.toLowerCase())) continue;
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
          headerBlacklist: [...headerBlacklist],
        });
        for (let attempt = 0; attempt <= step.retries; attempt++) {
          // Temporary diagnostic pacing: wait before each API request/attempt.
          await new Promise((resolve) => setTimeout(resolve, 2000));
          result.attempts++;
          const cookieSnapshot =
            process.env.RUN_LOG_RAW_HEADERS === "true"
              ? await snapshotCookies(context!, url.href, attempt + 1, headers)
              : undefined;
          if (cookieSnapshot) {
            const request = result.request as Record<string, unknown>;
            const diagnostics = (request.cookieDiagnostics ??= []) as unknown[];
            diagnostics.push(cookieSnapshot);
          }
          const response = await withRawRequestHeaders(
            {
              reportId: report.id,
              stepId: step.id,
              attempt: attempt + 1,
              method: a.method,
              url: url.href,
              headerBlacklist: [...headerBlacklist],
              onHeaders: ({ headers: actualHeaders, rawHeaders }) => {
                if (cookieSnapshot) {
                  Object.assign(
                    cookieSnapshot,
                    compareSentCookies(cookieSnapshot, actualHeaders),
                  );
                  console.info(
                    `[API_COOKIE_DIAGNOSTICS] ${JSON.stringify({ reportId: report.id, stepId: step.id, ...cookieSnapshot })}`,
                  );
                }
                result.request = {
                  ...(result.request as Record<string, unknown>),
                  headers: actualHeaders,
                  rawHeaders,
                  headersSource: "ACTUAL_REQUEST",
                };
              },
            },
            () =>
              context!.request.fetch(url.href, {
                method: a.method,
                headers,
                ...(body === undefined
                  ? {}
                  : step.bodyType === "form"
                    ? { form: body as Record<string, string> }
                    : { data: body }),
                timeout: step.timeoutMs,
                maxRedirects: 0,
              }),
          );
          let loginRedirect: URL | undefined;
          if ([301, 302, 303, 307, 308].includes(response.status())) {
            const location = response.headers().location;
            try {
              const destination = location
                ? new URL(location, url.href)
                : undefined;
              if (
                destination &&
                /(?:^|\/)(?:login|sign[-_]?in)(?:[/.]|$)/i.test(
                  destination.pathname,
                )
              )
                loginRedirect = destination;
            } catch {
              // A malformed Location remains an ordinary response for assertion checks.
            }
          }
          if (response.status() === 401 || loginRedirect) {
            if (
              response.status() === 401 &&
              !manualRetry &&
              a.risk === "READ" &&
              authProfile.reauthenticateReads &&
              attempt < step.retries
            ) {
              auth = await uiAuthenticate(context!, page, authProfile, env);
              for (const [k, b] of Object.entries({
                ...authProfile.headers,
                ...step.headers,
              })) {
                if (headerBlacklist.has(k.toLowerCase())) continue;
                const value = resolve(b, vars, auth, testData);
                if (value !== undefined) headers[k] = String(value);
              }
              continue;
            }
            const sessionEntries = await context!
              .cookies(url.href)
              .catch(() => []);
            const pageURL = new URL(activePage.url());
            const message = loginRedirect
              ? `接口返回 HTTP ${response.status()} 并跳转登录页 ${loginRedirect.origin}${loginRedirect.pathname}；当前请求未通过登录态或网关校验，请核对前置 UI 是否完成目标应用登录，以及当前会话与请求 Header 是否匹配`
              : "接口返回 HTTP 401，当前会话未通过认证；请检查前置 UI 登录结果";
            result.response = redact({
              status: response.status(),
              headers: response.headers(),
              authDiagnostics: {
                finalUIPage: `${pageURL.origin}${pageURL.pathname}`,
                uiRoute: pageURL.hash.match(/^#\/[A-Za-z0-9_/-]+/)?.[0],
                sessionEntries: sessionEntries.map(
                  ({
                    name,
                    domain,
                    path,
                    expires,
                    httpOnly,
                    secure,
                    sameSite,
                  }) => ({
                    name,
                    domain,
                    path,
                    expires,
                    httpOnly,
                    secure,
                    sameSite,
                  }),
                ),
              },
            });
            result.status = "AUTH_ERROR";
            report.auth = { status: "FAILED", error: message };
            throw new Error(message);
          }
          const declaredLength = Number(
            response.headers()["content-length"] ?? 0,
          );
          if (declaredLength > 1048576)
            throw new Error("Runner response limit exceeded");
          // Missing Content-Length is valid for finite chunked/HTTP2 responses.
          // Playwright's fetch timeout bounds receiving the response; validate
          // actual (decompressed) bytes as Content-Length alone is insufficient.
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
                    : assertion.operator === "contains"
                      ? Array.isArray(actual) &&
                        jsonArrayContains(actual, expected)
                      : assertion.operator === "notContains"
                        ? Array.isArray(actual) &&
                          !jsonArrayContains(actual, expected)
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
        if (
          !manualRetry &&
          step.failurePolicy === "STOP" &&
          step.phase !== "CLEANUP"
        )
          stopped = true;
      } finally {
        result.endedAt = Date.now();
        report.steps.push(result);
      }
    };
    retryStep = async (source, stepId) => {
      const step = p.steps.find((item) => item.id === stepId);
      const snapshot = snapshots.get(stepId);
      if (!step || !snapshot)
        throw new Error("仅支持重试原运行中已执行的 GET/HEAD 查询步骤。");
      const backup = structuredClone(vars);
      const retry: Report = {
        ...structuredClone(source),
        id: randomUUID(),
        retryOf: { reportId: source.id, stepId, sessionReportId: report.id },
        retrySession: { reportId: report.id },
        startedAt: Date.now(),
        endedAt: 0,
        status: "FAILED",
        auth: { status: "READY" },
        steps: [],
        resources: [],
        residualResources: [],
        cleanupStatus: "NOT_RUN",
      };
      try {
        for (const key of Object.keys(vars)) delete vars[key];
        Object.assign(vars, structuredClone(snapshot));
        await execute({ ...step, retries: 0 }, retry, true);
        retry.status =
          retry.steps[0]?.status === "PASSED" && retry.auth.status === "READY"
            ? "PASSED"
            : "FAILED";
        retry.endedAt = Date.now();
        return redactReport(retry);
      } finally {
        for (const key of Object.keys(vars)) delete vars[key];
        Object.assign(vars, backup);
      }
    };
    const steps = ordered(p.steps);
    try {
      await schedule(
        steps.filter((s) => s.phase !== "CLEANUP"),
        assets,
        // Temporary serial execution ensures the two-second gap is not bypassed by parallel steps.
        1,
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
    if (
      process.env.RUN_KEEP_BROWSER_OPEN === "true" &&
      browser?.isConnected() &&
      context &&
      context.pages().some((page) => !page.isClosed())
    ) {
      retainBrowser(report.id, browser, context, retryStep);
      if (retryStep && report.steps.some((step) => step.retryable))
        report.retrySession = { reportId: report.id };
      report.debug = {
        rawRequestHeaders: report.debug?.rawRequestHeaders ?? false,
        browserRetained: true,
      };
      console.info(
        `[BROWSER_RETAINED] reportId=${report.id}; browser and context remain open for inspection.`,
      );
    } else {
      await context?.close();
      await browser?.close();
    }
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
  return redactReport(report);
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
  validateDataset(p, dataset, true);
  const batchId = randomUUID();
  const reports: Report[] = [];
  for (const row of dataset.rows) {
    // Each row uses a fresh browser, auth context, response variables and resource ledger.
    const report = await run(
      c,
      p,
      assets,
      env,
      authProfile,
      row.values,
      dataset.review,
    );
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
