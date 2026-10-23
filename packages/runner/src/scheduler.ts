import type { Asset, Step } from "../../contracts/src/index.js";
import { ordered } from "../../core/src/index.js";
export function parallelEligible(step: Step, assets: Asset[]): boolean {
  const asset = assets.find(
    (a) => a.apiId === step.apiId && a.version === (step.apiVersion ?? 1),
  );
  return (
    !!step.parallelSafe &&
    step.phase === "API" &&
    asset?.risk === "READ" &&
    asset.operationType === "READ" &&
    ["GET", "HEAD"].includes(asset.method)
  );
}
export async function schedule(
  steps: Step[],
  assets: Asset[],
  maxConcurrency: number,
  execute: (step: Step) => Promise<void>,
  allowParallel = true,
) {
  const pending = ordered(steps);
  const completed = new Set<string>();
  const running = new Map<string, { step: Step; promise: Promise<void> }>();
  const start = (step: Step) => {
    pending.splice(pending.indexOf(step), 1);
    const promise = Promise.resolve()
      .then(() => execute(step))
      .finally(() => {
        completed.add(step.id);
        running.delete(step.id);
      });
    running.set(step.id, { step, promise });
  };
  while (pending.length || running.size) {
    const ready = pending.filter((s) =>
      s.dependsOn.every((id) => completed.has(id)),
    );
    for (const step of ready) {
      const parallel =
        allowParallel && maxConcurrency > 1 && parallelEligible(step, assets);
      if (!parallel) {
        if (!running.size) start(step);
        break;
      }
      if (running.size >= maxConcurrency) break;
      const conflict = [...running.values()].some(
        (active) =>
          !parallelEligible(active.step, assets) ||
          (step.resourceLocks ?? []).some((lock) =>
            active.step.resourceLocks?.includes(lock),
          ),
      );
      if (!conflict) start(step);
    }
    if (!running.size) {
      if (pending.length)
        throw new Error("Workflow has unsatisfied dependencies");
      break;
    }
    try {
      await Promise.race([...running.values()].map((entry) => entry.promise));
    } catch (error) {
      await Promise.allSettled(
        [...running.values()].map((entry) => entry.promise),
      );
      throw error;
    }
  }
}
