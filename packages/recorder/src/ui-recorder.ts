import { AuthHintDiscovery } from "./auth-hints.js";
import type { AuthSourceHint } from "../../contracts/src/index.js";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { action, type Environment } from "../../contracts/src/index.js";
import { allowedURL, redact } from "../../core/src/index.js";
import { z } from "zod";

export class UIRecorder {
  readonly id = randomUUID();
  browser?: Browser;
  context?: BrowserContext;
  actions: z.infer<typeof action>[] = [];
  authHints: AuthSourceHint[] = [];
  private pending = new Set<Promise<void>>();
  private authScans = 0;
  private discovery?: AuthHintDiscovery;
  state: "RECORDING" | "STOPPED" = "RECORDING";
  constructor(
    readonly environment: Environment,
    readonly target: string,
  ) {}
  snapshot() {
    return {
      id: this.id,
      environmentRef: this.environment.id,
      target: this.target,
      state: this.state,
      actions: structuredClone(this.actions),
      authHints: structuredClone(this.authHints),
    };
  }
  async start(headless = false) {
    allowedURL(this.target, this.environment);
    if (redact(this.target) !== this.target)
      throw new Error("录制起始 URL 不能包含敏感参数");
    this.browser = await chromium.launch({
      headless,
      executablePath:
        process.env.CHROMIUM_PATH ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    });
    this.context = await this.browser.newContext({
      ignoreHTTPSErrors: this.environment.ignoreHTTPSErrors ?? false,
    });
    await this.context.route("**/*", async (route) => {
      try {
        allowedURL(route.request().url(), this.environment);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    const discovery = new AuthHintDiscovery(this.context, this.authHints);
    this.discovery = discovery;
    this.context.on("response", (response) => {
      if (
        this.state !== "RECORDING" ||
        this.pending.size >= 32 ||
        !["fetch", "xhr"].includes(response.request().resourceType())
      )
        return;
      const pending = discovery
        .response(response)
        .finally(() => this.pending.delete(pending));
      this.pending.add(pending);
    });
    this.context.on("request", (request) => {
      if (
        this.state !== "RECORDING" ||
        this.authScans >= 128 ||
        this.pending.size >= 8 ||
        !["fetch", "xhr"].includes(request.resourceType())
      )
        return;
      this.authScans++;
      const pending = discovery
        .request(request)
        .finally(() => this.pending.delete(pending));
      this.pending.add(pending);
    });
    let inputIndex = 0;
    await this.context.exposeBinding("__uiRecord", (source, event: unknown) => {
      if (
        this.state !== "RECORDING" ||
        source.frame !== source.page.mainFrame() ||
        this.actions.length >= 1000
      )
        return;
      const parsed = action.safeParse(event);
      if (
        !parsed.success ||
        !["click", "fill", "selectOption", "press"].includes(parsed.data.type)
      )
        return;
      const next = parsed.data;
      // Never accept field values from the browser. Inputs are environment references.
      if (next.type === "fill" || next.type === "selectOption") {
        const previous = this.actions.at(-1);
        if (previous?.type === next.type && previous.target === next.target)
          return;
        this.actions.push({
          type: next.type,
          target: next.target,
          secretRef: `UI_INPUT_${++inputIndex}`,
        });
      } else if (next.type === "press") {
        if (next.value === "Enter")
          this.actions.push({
            type: "press",
            target: next.target,
            value: "Enter",
          });
      } else this.actions.push({ type: next.type, target: next.target });
    });
    await this.context.addInitScript({
      path: fileURLToPath(new URL("./ui-browser-recorder.js", import.meta.url)),
    });
    const page = await this.context.newPage();
    this.actions.push({ type: "navigate", target: this.target });
    page.on("framenavigated", (frame) => {
      if (
        this.state !== "RECORDING" ||
        frame !== page.mainFrame() ||
        frame.url() === "about:blank"
      )
        return;
      // A navigation caused by a click is awaited, rather than performed twice.
      if (
        this.actions.at(-1)?.type !== "navigate" &&
        this.actions.length < 1000
      )
        this.actions.push({
          type: "waitForURL",
          target:
            new URL(frame.url()).origin + new URL(frame.url()).pathname + "**",
        });
    });
    await page.goto(this.target);
  }
  async stop() {
    this.state = "STOPPED";
    await this.browser?.close();
    await Promise.allSettled(this.pending);
    this.discovery?.clear();
    return this.snapshot();
  }
}
