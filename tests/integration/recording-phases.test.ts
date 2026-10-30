import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { createApp } from "../../apps/server/src/app";
import { Store } from "../../packages/storage/src/index";
import { MockAIProvider } from "../../packages/planner/src/index";
import { demoEnv } from "../../apps/server/src/demo";

it("persists recording hints, HTML navigation and explicit phase markers", async () => {
  vi.stubEnv("RECORDER_HEADLESS", "true");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<div>Ready</div>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const store = new Store("file::memory:");
  const app = await createApp(store, new MockAIProvider());
  try {
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: { ...demoEnv, id: "phases", baseURL, allowedOrigins: [baseURL] },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/recordings",
      payload: {
        caseName: "带资料录制",
        scenario: "创建后恢复",
        target: baseURL + "/#/entry",
        environmentRef: "phases",
        referenceMaterial: "名称不可重复",
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const id = started.json().id;
    for (const phase of ["BUSINESS", "RECOVERY"]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/recordings/${id}/phase`,
            payload: { phase },
          })
        ).statusCode,
      ).toBe(200);
    }
    const stopped = await app.inject({
      method: "POST",
      url: `/api/recordings/${id}/stop`,
      payload: {},
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    const saved = (await app.inject(`/api/recordings/${id}`)).json();
    expect(saved.referenceMaterial).toBe("名称不可重复");
    expect(
      saved.phaseMarkers.map((item: { phase: string }) => item.phase),
    ).toEqual(["BUSINESS", "RECOVERY"]);
    expect(saved.pageNavigations[0]).toMatchObject({
      url: baseURL + "/#/entry",
      status: 200,
      contentType: "text/html",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/recordings/${id}/phase`,
          payload: { phase: "BUSINESS" },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  }
});
