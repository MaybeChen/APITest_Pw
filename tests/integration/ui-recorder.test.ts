import { applyAuthHints } from "../../apps/web/src/components/AuthSourceHints";
import { redact } from "../../packages/core/src/index";
import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { UIRecorder } from "../../packages/recorder/src/ui-recorder";
import { uiAuthenticate } from "../../packages/runner/src/index";
import { createApp } from "../../apps/server/src/app";
import { Store } from "../../packages/storage/src/index";
import { MockAIProvider } from "../../packages/planner/src/index";
import type { Environment } from "../../packages/contracts/src/index";

it("records literal UI inputs, persists the profile, and replays without input environment variables", async () => {
  const submitted: URLSearchParams[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/login") {
      res.setHeader("content-type", "text/html");
      res.end(
        '<form action="/done"><input id="user" name="user"><input id="password" name="password" type="password"><select id="tenant" name="tenant"><option value="a">A</option><option value="b">B</option></select><button id="login">登录</button></form>',
      );
    } else if (req.url?.startsWith("/done")) {
      submitted.push(new URL(req.url, "http://localhost").searchParams);
      res.setHeader("set-cookie", [
        "session=ui-session; HttpOnly; Path=/",
        "csrf-cookie=private-csrf-value; HttpOnly; Path=/",
      ]);
      res.setHeader("content-type", "text/html");
      res.end(`<div id="ready">Ready</div><script>
        localStorage.setItem('access-key', 'private-local-token');
        sessionStorage.setItem('page-key', 'private-session-token');
        fetch('/private', {headers: {'x-gde-csrf-token':'private-csrf-value','x-page-token':sessionStorage.getItem('page-key'),authorization:'Bearer '+localStorage.getItem('access-key')}});
      </script>`);
    } else if (req.url === "/private") {
      res.statusCode = req.headers.cookie?.includes("session=ui-session")
        ? 200
        : 401;
      res.end("ok");
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseURL = `http://127.0.0.1:${port}`;
  const env: Environment = {
    id: "ui-test",
    baseURL,
    allowedOrigins: [baseURL],
    allowWrites: false,
    allowHighRisk: false,
    ignoreHTTPSErrors: false,
  };
  const app = await createApp(new Store("file::memory:"), new MockAIProvider());
  vi.stubEnv("RECORDER_HEADLESS", "true");
  // Test API lifecycle as well as browser capture using a direct recorder below.
  await app.inject({ method: "POST", url: "/api/environments", payload: env });
  let rec: UIRecorder | undefined;
  try {
    const started = await app.inject({
      method: "POST",
      url: "/api/ui-recordings",
      payload: { target: baseURL + "/login", environmentRef: env.id },
    });
    expect(started.statusCode, started.body).toBe(200);
    const id = started.json().id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ui-recordings",
          payload: { target: baseURL + "/login", environmentRef: env.id },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/ui-recordings/${id}/stop`,
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject("/api/ui-recordings")).json()[0].state).toBe(
      "STOPPED",
    );
    rec = new UIRecorder(env, baseURL + "/login");
    await rec.start(true);
    const page = rec.context!.pages()[0];
    await page.locator("#user").fill("wrong-value");
    await page.locator("#user").fill("private-user");
    await page.locator("#password").fill("private-password");
    await page.locator("#tenant").selectOption("b");
    await page.locator("#password").press("Enter");
    await page.locator("#ready").waitFor();
    await expect
      .poll(() => rec!.actions.some((a) => a.type === "waitForURL"))
      .toBe(true);
    await expect.poll(() => rec!.authHints.length).toBe(3);
    const snapshot = await rec.stop();
    expect(JSON.stringify(snapshot)).not.toMatch(
      /private-csrf-value|private-local-token|private-session-token/,
    );
    expect(snapshot.actions.filter((a) => a.type === "fill")).toHaveLength(2);
    expect(snapshot.actions.find((a) => a.type === "selectOption")?.value).toBe(
      "b",
    );
    expect(snapshot.actions.filter((a) => a.type === "click")).toHaveLength(0);
    expect(snapshot.actions.find((a) => a.target === "#user")?.value).toBe(
      "private-user",
    );
    expect(snapshot.actions.find((a) => a.target === "#password")?.value).toBe(
      "private-password",
    );
    expect(snapshot.actions.every((a) => !a.secretRef)).toBe(true);
    vi.stubEnv("UI_INPUT_1", undefined);
    vi.stubEnv("UI_INPUT_2", undefined);
    const profile = applyAuthHints(
      {
        id: "recorded-auth",
        environmentRef: env.id,
        recordingRef: rec.id,
        actions: snapshot.actions,
        readySelector: "#ready",
        headers: {},
        tokenSources: {},
        reauthenticateReads: false,
      },
      snapshot.authHints,
    );
    expect(profile.tokenSources.recorded_x_gde_csrf_token.source).toBe(
      "cookie",
    );
    expect(
      redact(snapshot.authHints).find(
        (hint: { header: string }) => hint.header === "authorization",
      ).prefix,
    ).toBe("Bearer ");
    const saved = await app.inject({
      method: "POST",
      url: "/api/auth-profiles",
      payload: profile,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().recordingRef).toBe(rec.id);
    const persisted = (await app.inject("/api/auth-profiles"))
      .json()
      .find((p: { id: string }) => p.id === profile.id);
    expect(persisted.actions).toEqual(snapshot.actions);
    const replay = new UIRecorder(env, baseURL + "/login");
    try {
      await replay.start(true);
      expect(
        (await replay.context!.request.get(baseURL + "/private")).status(),
      ).toBe(401);
      const extracted = await uiAuthenticate(
        replay.context!,
        replay.context!.pages()[0],
        profile,
        env,
      );
      expect(await replay.context!.pages()[0].locator("#ready").count()).toBe(
        1,
      );
      expect(Object.fromEntries(submitted.at(-1)!)).toEqual({
        user: "private-user",
        password: "private-password",
        tenant: "b",
      });
      expect(extracted.recorded_x_gde_csrf_token).toBe("private-csrf-value");
      expect(extracted.recorded_x_page_token).toBe("private-session-token");
      expect(extracted.recorded_authorization).toBe(
        "Bearer private-local-token",
      );
      expect(
        (await replay.context!.request.get(baseURL + "/private")).status(),
      ).toBe(200);
      await expect(
        uiAuthenticate(replay.context!, replay.context!.pages()[0], profile, {
          ...env,
          id: "other",
        }),
      ).rejects.toThrow("environment mismatch");
    } finally {
      await replay.stop();
    }
  } finally {
    await rec?.stop();
    await app.close();
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 30000);

it("discovers a csrf value from the UI bootstrap response and extracts a fresh value on replay without duplicate requests", async () => {
  let calls = 0;
  let current = "";
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end(`<div id="ready" hidden>Ready</div><script>
        fetch('/adc-system/web/rest/v1/uiconfig/info').then(r=>r.json()).then(async data=>{
          await fetch('/private', {headers: {'x-gde-csrf-token':data.data.csrfToken}});
          document.getElementById('ready').hidden=false;
        });
      </script>`);
    } else if (req.url === "/adc-system/web/rest/v1/uiconfig/info") {
      current = `private-response-csrf-${++calls}`;
      res.setHeader("x-bootstrap-csrf", current);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { csrfToken: current } }));
    } else {
      res.statusCode = req.headers["x-gde-csrf-token"] === current ? 200 : 403;
      res.end("ok");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env: Environment = {
    id: "csrf",
    baseURL,
    allowedOrigins: [baseURL],
    allowWrites: false,
    allowHighRisk: false,
    ignoreHTTPSErrors: false,
  };
  const capture = new UIRecorder(env, baseURL);
  let replay: UIRecorder | undefined;
  try {
    await capture.start(true);
    await capture.context!.pages()[0].locator("#ready").waitFor();
    await expect.poll(() => capture.authHints.length).toBe(2);
    const snapshot = await capture.stop();
    expect(
      snapshot.authHints.find((hint) => hint.source === "response"),
    ).toMatchObject({
      header: "x-gde-csrf-token",
      source: "response",
      storageKey: "$.data.csrfToken",
      url: baseURL + "/adc-system/web/rest/v1/uiconfig/info",
      method: "GET",
    });
    expect(JSON.stringify(snapshot)).not.toContain("private-response-csrf");
    const profile = applyAuthHints(
      {
        id: "csrf-ui",
        environmentRef: env.id,
        actions: snapshot.actions,
        readySelector: "#ready",
        headers: {},
        tokenSources: {},
        reauthenticateReads: false,
      },
      snapshot.authHints.filter((hint) => hint.source === "response"),
    );
    replay = new UIRecorder(env, baseURL);
    await replay.start(true);
    await replay.context!.pages()[0].locator("#ready").waitFor();
    const before = calls;
    const auth = await uiAuthenticate(
      replay.context!,
      replay.context!.pages()[0],
      profile,
      env,
    );
    expect(calls).toBe(before + 1); // Exactly the UI navigation request, no extra API fetch.
    expect(auth.recorded_x_gde_csrf_token).toBe(current);
    const response = await replay.context!.request.get(baseURL + "/private", {
      headers: { "x-gde-csrf-token": auth.recorded_x_gde_csrf_token },
    });
    expect(response.status()).toBe(200);
    const again = await uiAuthenticate(
      replay.context!,
      replay.context!.pages()[0],
      { ...profile, actions: [] },
      env,
      auth,
    );
    expect(again).toEqual(auth);
    expect(calls).toBe(before + 1);
    const headerHints = snapshot.authHints.filter(
      (hint) => hint.source === "responseHeader",
    );
    expect(headerHints[0].storageKey).toBe("x-bootstrap-csrf");
    const headerProfile = applyAuthHints(profile, headerHints);
    const headerAuth = await uiAuthenticate(
      replay.context!,
      replay.context!.pages()[0],
      headerProfile,
      env,
    );
    expect(calls).toBe(before + 2);
    expect(headerAuth.recorded_x_gde_csrf_token).toBe(current);
  } finally {
    await capture.stop();
    await replay?.stop();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 30000);
