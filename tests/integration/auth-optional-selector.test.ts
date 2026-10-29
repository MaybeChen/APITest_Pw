import { expect, it } from "vitest";
import { createApp } from "../../apps/server/src/app";
import { Store } from "../../packages/storage/src/index";
import { MockAIProvider } from "../../packages/planner/src/index";
import { demoAuth } from "../../apps/server/src/demo";

it("saves UI profiles with omitted or blank readiness selectors", async () => {
  const app = await createApp(new Store("file::memory:"), new MockAIProvider());
  try {
    for (const readySelector of [undefined, "", "   "]) {
      const profile = { ...demoAuth, id: "optional", readySelector };
      const response = await app.inject({
        method: "POST",
        url: "/api/auth-profiles",
        payload: profile,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().readySelector).toBe(
        readySelector === undefined ? undefined : "",
      );
    }
    const profiles = (await app.inject("/api/auth-profiles")).json();
    expect(
      profiles.find((profile: { id: string }) => profile.id === "optional")
        .readySelector,
    ).toBe("");
  } finally {
    await app.close();
  }
});
