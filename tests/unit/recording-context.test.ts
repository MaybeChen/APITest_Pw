import { expect, it } from "vitest";
import { recordingSchema } from "../../packages/contracts/src/index";
import { analyze } from "../../packages/recorder/src/index";
import { initializationCandidates } from "../../packages/recorder/src/recording-context";

function fixture() {
  return recordingSchema.parse({
    id: "phases",
    caseName: "动态参数",
    scenario: "创建后恢复",
    target: "https://example.test/portal",
    state: "STOPPED",
    startedAt: 0,
    referenceMaterial: "参数名称唯一",
    phaseMarkers: [
      { phase: "BUSINESS", at: 90 },
      { phase: "RECOVERY", at: 120 },
    ],
    operations: [],
    pageNavigations: [
      {
        id: "portal",
        pageId: "main",
        url: "https://example.test/portal",
        startedAt: 1,
        status: 200,
        contentType: "text/html",
        newWindow: false,
      },
      {
        id: "app",
        pageId: "popup",
        url: "https://example.test/studio#/page",
        startedAt: 50,
        status: 200,
        contentType: "text/html",
        newWindow: true,
      },
      {
        id: "other",
        pageId: "main",
        url: "https://example.test/other",
        startedAt: 95,
        status: 200,
        contentType: "text/html",
        newWindow: false,
      },
    ],
    requests: [
      {
        id: "menus",
        pageId: "popup",
        url: "https://example.test/api/menus",
        method: "GET",
        resourceType: "fetch",
        startedAt: 60,
        endedAt: 61,
        status: 200,
        headers: {},
        response: { theme: "light" },
      },
      {
        id: "lookup",
        pageId: "popup",
        url: "https://example.test/api/list",
        method: "GET",
        resourceType: "fetch",
        startedAt: 70,
        endedAt: 71,
        status: 200,
        headers: {},
        response: { data: [{ id: 7, placeholder_key: "existing_key" }] },
      },
      {
        id: "create",
        pageId: "popup",
        url: "https://example.test/api/save",
        method: "POST",
        resourceType: "fetch",
        startedAt: 100,
        endedAt: 101,
        status: 200,
        headers: {},
        body: { placeholder_key: "existing_key" },
      },
      {
        id: "cleanup",
        pageId: "popup",
        url: "https://example.test/api/item/8",
        method: "DELETE",
        resourceType: "fetch",
        startedAt: 130,
        status: 204,
        headers: {},
      },
    ],
  });
}
it("filters page initialization calls, keeps a real name dependency and selects the nearest HTML in the correct window", () => {
  const output = analyze(fixture());
  expect(
    output.recording.requests.find((item) => item.id === "menus"),
  ).toMatchObject({ category: "PAGE_INITIALIZATION", keep: false });
  expect(
    output.recording.requests.find((item) => item.id === "lookup")?.keep,
  ).toBe(true);
  expect(output.assets.some((asset) => asset.sources.includes("menus"))).toBe(
    false,
  );
  expect(
    output.recording.requests.find((item) => item.id === "cleanup")
      ?.recordingPhase,
  ).toBe("RECOVERY");
  expect(output.recording.applicationCandidates).toEqual([
    {
      navigationId: "app",
      url: "https://example.test/studio#/page",
      newWindow: true,
      enabled: true,
      requestIds: ["lookup", "create", "cleanup"],
    },
  ]);
  expect(initializationCandidates(output.recording, [])[0].enabled).toBe(false);
  const manual = analyze(fixture(), { overrides: { lookup: false } });
  expect(
    manual.recording.requests.find((item) => item.id === "lookup")?.keep,
  ).toBe(false);
});
it("uses per-page interaction when phase markers are absent, and leaves legacy evidence unchanged", () => {
  const recording = fixture();
  delete recording.phaseMarkers;
  recording.operations.push({
    id: "click",
    type: "click",
    at: 90,
    url: "https://example.test/studio",
    context: { pageId: "popup" },
    requestIds: [],
  });
  expect(
    analyze(recording).recording.requests.find((item) => item.id === "create")
      ?.recordingPhase,
  ).toBe("BUSINESS");
  delete recording.pageNavigations;
  expect(
    analyze(recording).recording.requests.find((item) => item.id === "menus")
      ?.keep,
  ).toBe(true);
});
