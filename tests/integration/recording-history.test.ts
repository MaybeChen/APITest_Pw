import { expect, it } from "vitest";
import { createApp } from "../../apps/server/src/app";
import { Store } from "../../packages/storage/src/index";

it("deletes a history entry persistently and idempotently while preserving other records and saved artifacts", async () => {
  const store = new Store("file::memory:");
  const app = await createApp(store);
  try {
    await store.put("recording", "first", 1, {
      id: "first",
      workspaceId: "one",
    });
    await store.put("recording", "second", 1, {
      id: "second",
      workspaceId: "two",
    });
    await store.put("case", "saved-case", 1, { caseId: "saved-case" });
    await store.put("generation", "saved-job", 1, {
      id: "saved-job",
      state: "NEEDS_REVIEW",
      input: { recording: { id: "first" } },
    });
    for (let i = 0; i < 2; i++) {
      expect(
        (await app.inject({ method: "DELETE", url: "/api/recordings/first" }))
          .statusCode,
      ).toBe(204);
    }
    const list = await app.inject({ method: "GET", url: "/api/recordings" });
    expect(list.json().map((r: { id: string }) => r.id)).toEqual(["second"]);
    expect(await store.get("recording-deletion", "first")).toMatchObject({
      id: "first",
    });
    expect(await store.get("case", "saved-case")).toEqual({
      caseId: "saved-case",
    });
    expect(await store.get("generation", "saved-job")).toBeDefined();
    expect(
      (await app.inject({ method: "DELETE", url: "/api/recordings/missing" }))
        .statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
