import { expect, it } from "vitest";
import { createApp } from "../../apps/server/src/app";
import { Store } from "../../packages/storage/src/index";
import { MockAIProvider } from "../../packages/planner/src/index";
import { demoAuth, demoEnv } from "../../apps/server/src/demo";

it("deletes all configuration versions, protects environment references and preserves test artifacts", async () => {
  const store = new Store("file::memory:");
  const app = await createApp(store, new MockAIProvider());
  try {
    for (let version = 1; version <= 2; version++) {
      await store.put("environment", "custom", version, {
        ...demoEnv,
        id: "custom",
      });
      await store.put("auth", "custom-ui", version, {
        ...demoAuth,
        id: "custom-ui",
        environmentRef: "custom",
      });
    }
    await store.put("plan", "retained-plan", 1, {
      environmentRef: "custom",
      authProfileRef: "custom-ui",
    });
    const blocked = await app.inject({
      method: "DELETE",
      url: "/api/environments/custom",
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain("custom-ui");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/auth-profiles/custom-ui",
        })
      ).statusCode,
    ).toBe(204);
    expect(await store.get("auth", "custom-ui")).toBeUndefined();
    expect(
      (await app.inject("/api/auth-profiles"))
        .json()
        .some((item: { id: string }) => item.id === "custom-ui"),
    ).toBe(false);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/environments/custom" }))
        .statusCode,
    ).toBe(204);
    expect(await store.get("environment", "custom", 1)).toBeUndefined();
    expect(await store.get("environment", "custom", 2)).toBeUndefined();
    expect(await store.get("plan", "retained-plan")).toBeDefined();
    expect(
      (await app.inject({ method: "DELETE", url: "/api/environments/custom" }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/environments",
          payload: { ...demoEnv, id: "custom", createOnly: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/auth-profiles/${demoAuth.id}`,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/environments/${demoEnv.id}`,
        })
      ).statusCode,
    ).toBe(204);
    // Reinitialize the application against the same data: deleted defaults stay deleted.
    const reopened = await createApp(store, new MockAIProvider());
    expect(await store.get("auth", demoAuth.id)).toBeUndefined();
    expect(await store.get("environment", demoEnv.id)).toBeUndefined();
    await reopened.close();
  } finally {
    await app.close();
  }
});
