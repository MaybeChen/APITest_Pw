import { useEffect, useState } from "react";
import type { Generation } from "../../../../packages/planner/src/workflow";
export function GenerationProgress({
  onOpen,
}: {
  onOpen: (job: Generation) => void;
}) {
  const [jobs, setJobs] = useState<Generation[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/generations");
        if (!response.ok) throw new Error(await response.text());
        const data = (await response.json()) as Generation[];
        if (!cancelled) setJobs(data);
      } catch (error) {
        if (!cancelled) setError(String(error));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return (
    <section>
      <h3>生成工作流</h3>
      <p>
        阶段结果自动保存。中断后可继续；完成后仍需审核接口契约、参数传递和断言。
      </p>
      {error && <p role="alert">{error}</p>}
      {jobs.map((job) => (
        <details key={job.id} open={job.state !== "NEEDS_REVIEW"}>
          <summary>
            {job.id.slice(0, 8)} · {job.state}
          </summary>
          <ol>
            {job.stages.map((stage) => (
              <li key={stage.id}>
                {stage.id} · {stage.state} · 尝试 {stage.attempts}
                {stage.error && <pre>{stage.error}</pre>}
                <details>
                  <summary>阶段产物</summary>
                  <pre>{JSON.stringify(stage.output, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ol>
          {job.validation && (
            <pre>{JSON.stringify(job.validation, null, 2)}</pre>
          )}
          {job.state === "NEEDS_REVIEW" ? (
            <button onClick={() => onOpen(job)}>打开草稿</button>
          ) : (
            <button
              onClick={() =>
                void fetch(`/api/generations/${job.id}/resume`, {
                  method: "POST",
                })
                  .then(async (response) => {
                    if (!response.ok) setError(await response.text());
                  })
                  .catch((error) => setError(String(error)))
              }
            >
              继续未完成阶段
            </button>
          )}
        </details>
      ))}
    </section>
  );
}
