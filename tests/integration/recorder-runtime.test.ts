import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { Recording } from "../../packages/contracts/src/index";
it("records DOM context under the actual tsx runtime across reloads, frames and popups", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("../fixtures/recorder-runtime.ts", import.meta.url),
      ),
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout) as {
    recording: Recording;
    modelRecording: Recording;
    errors: string[];
  };
  expect(result.errors).toEqual([]);
  expect(
    result.recording.contextCapture?.initializedFrames,
  ).toBeGreaterThanOrEqual(4);
  expect(result.recording.contextCapture?.rejectedEvents).toBe(0);
  expect(result.recording.operations.some((op) => op.type === "input")).toBe(
    true,
  );
  for (const [path, heading] of [
    ["main", "Main context"],
    ["frame", "Frame context"],
    ["popup", "Popup context"],
  ]) {
    const req = result.modelRecording.requests.find(
      (req) => new URL(req.url).pathname === `/api/${path}`,
    )!;
    expect(req).toBeDefined();
    expect(req.contextSnapshotRefs?.length).toBeGreaterThan(0);
    const snapshots = result.modelRecording.contextSnapshots!.filter((s) =>
      req.contextSnapshotRefs?.includes(s.id),
    );
    expect(
      snapshots.some(
        (s) => s.phase === "BEFORE" && s.headings.includes(heading),
      ),
    ).toBe(true);
    expect(
      snapshots.some(
        (s) => s.phase === "AFTER" && s.headings.includes(heading),
      ),
    ).toBe(true);
  }
  expect(stdout).not.toMatch(/private-default-value|private-typed-value/);
});
