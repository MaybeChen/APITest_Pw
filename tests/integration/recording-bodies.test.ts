import { it, expect } from "vitest";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { Recorder } from "../../packages/recorder/src/index";
import { demoEnv } from "../../apps/server/src/demo";
it("captures bounded JSON once per response and explains missing, empty and oversized bodies", async () => {
  const paths = [
    "/api/json?topic=all",
    "/api/empty",
    "/api/chunked",
    "/api/large",
    "/api/plain",
    "/api/binary",
    "/api/compressed",
    ...Array.from({ length: 7 }, (_, i) => "/api/budget-" + i),
  ];
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === "/") {
      const body = `<html><body><script>Promise.all(${JSON.stringify(paths)}.map(path=>fetch(path,path.includes('/api/json')?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'do-not-store-this-password',topic:'all'})}:{}).then(response=>response.arrayBuffer()))).then(()=>document.body.dataset.done='true')</script></body></html>`;
      res.writeHead(200, {
        "content-type": "text/html",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (req.url === "/api/empty") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === "/api/chunked") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ok":');
      res.end("true}");
      return;
    }
    const large = req.url === "/api/large",
      binary = req.url === "/api/binary",
      plain = req.url === "/api/plain",
      compressed = req.url === "/api/compressed";
    const text = plain
      ? "sensitive plain text must be omitted"
      : binary
        ? "binary"
        : JSON.stringify(
            req.url?.startsWith("/api/budget")
              ? { data: "x".repeat(160000) }
              : large || compressed
                ? { data: "x".repeat(270000) }
                : { ok: true, token: "do-not-store-this-token" },
          );
    const body = compressed ? gzipSync(text) : Buffer.from(text);
    res.writeHead(200, {
      "content-type": binary
        ? "application/octet-stream"
        : plain
          ? "text/plain"
          : "application/json",
      "content-length": body.length,
      ...(compressed ? { "content-encoding": "gzip" } : {}),
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const recorder = new Recorder(
    {
      caseName: "响应证据采集",
      scenario: "响应内容与省略原因",
      target: baseURL,
    },
    { ...demoEnv, baseURL, allowedOrigins: [baseURL] },
  );
  try {
    const page = await recorder.start(true);
    await page.waitForFunction(() => document.body.dataset.done === "true");
    const recording = await recorder.stop();
    const byPath = (path: string) =>
      recording.requests.find((r) => new URL(r.url).pathname === path)!;
    expect(byPath("/api/json").response).toEqual({
      ok: true,
      token: "[REDACTED]",
    });
    expect(byPath("/api/json").body).toEqual({
      password: "[REDACTED]",
      topic: "all",
    });
    expect(byPath("/api/json").query.topic).toBe("all");
    expect(byPath("/api/empty").responseBodyCapture?.state).toBe("EMPTY");
    expect(byPath("/api/chunked").responseBodyCapture?.reason).toContain(
      "Content-Length",
    );
    expect(byPath("/api/chunked").status).toBe(200);
    expect(byPath("/api/chunked").failure).toBeUndefined();
    expect(byPath("/api/large").responseBodyCapture?.state).toBe("OMITTED");
    expect(byPath("/api/compressed").responseBodyCapture?.reason).toContain(
      "解压",
    );
    expect(byPath("/api/compressed").response).toBeUndefined();
    expect(byPath("/api/plain").responseBodyCapture?.reason).toContain("隐私");
    expect(byPath("/api/binary").responseBodyCapture?.reason).toContain(
      "内容类型",
    );
    for (let i = 0; i < 7; i++)
      expect(byPath("/api/budget-" + i).responseBodyCapture?.state).toBe(
        "CAPTURED",
      );
    expect(JSON.stringify(recording)).not.toContain("do-not-store-this-");
  } finally {
    await recorder.stop();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
