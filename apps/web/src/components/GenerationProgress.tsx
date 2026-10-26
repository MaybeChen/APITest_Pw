import { useEffect, useState } from "react";
import type { Generation } from "../../../../packages/planner/src/workflow";
const labels: Record<string, string> = {
  EVIDENCE: "整理录制证据",
  BUSINESS_FLOW: "识别业务流程",
  SEMANTIC_CASE: "生成业务用例",
  EXECUTION_PLAN: "生成调用计划",
  VALIDATION: "校验计划",
  REPAIR: "修复问题",
  FINAL_VALIDATION: "最终校验",
  PENDING: "等待中",
  RUNNING: "进行中",
  SUCCEEDED: "已完成",
  FAILED: "失败",
  SKIPPED: "无需执行",
  NEEDS_REVIEW: "待审核",
};
function duration(start?: number, end?: number) {
  if (start === undefined) return "—";
  const seconds = Math.max(0, (end ?? Date.now()) - start) / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)} 秒`
    : `${Math.floor(seconds / 60)} 分 ${(seconds % 60).toFixed(0)} 秒`;
}
export function GenerationProgress({
  onOpen,
}: {
  onOpen: (job: Generation) => void;
}) {
  const [jobs, setJobs] = useState<(Generation & { active?: boolean })[]>([]);
  const [error, setError] = useState("");
  const [resuming, setResuming] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch("/api/generations");
        if (!response.ok) throw new Error(await response.text());
        const data = (await response.json()) as (Generation & {
          active?: boolean;
        })[];
        if (!cancelled) {
          setJobs(data);
          setError("");
        }
      } catch (error) {
        if (!cancelled) setError(String(error));
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 1500);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  const resume = async (job: Generation) => {
    setResuming(job.id);
    try {
      const response = await fetch(`/api/generations/${job.id}/resume`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await response.text());
      setError("");
    } catch (error) {
      setError(String(error));
    } finally {
      setResuming(undefined);
    }
  };
  return (
    <section>
      <h3>生成工作流</h3>
      <p>
        阶段结果自动保存。失败后可继续；完成后请审核接口契约、参数传递和断言。
      </p>
      {error && (
        <p className="error" role="alert">
          刷新或操作失败：{error}
        </p>
      )}
      {!jobs.length && (
        <p className="empty">暂无生成任务。分析录制后即可开始生成。</p>
      )}
      {jobs.map((job) => {
        const interrupted = job.state === "RUNNING" && job.active === false;
        const current =
          job.stages.find((s) => s.state === "RUNNING") ??
          job.stages.find((s) => s.state === "FAILED");
        const completed = job.stages.filter((s) =>
          ["SUCCEEDED", "SKIPPED"].includes(s.state),
        ).length;
        return (
          <article className="generation" key={job.id}>
            <div className="row">
              <strong>{job.input.recording.caseName}</strong>
              <span
                className={`badge ${job.state === "FAILED" ? "failed" : ""}`}
              >
                {interrupted ? "已中断，可继续" : labels[job.state]}
              </span>
            </div>
            <p>
              任务 {job.id.slice(0, 8)} · {job.provider.name} /{" "}
              {job.provider.version}
            </p>
            <div className="generation-summary">
              <span>
                当前阶段：
                <strong>
                  {current
                    ? labels[current.id]
                    : job.state === "NEEDS_REVIEW"
                      ? "生成完成，等待审核"
                      : "等待执行"}
                </strong>
              </span>
              <span>
                总耗时：
                {duration(
                  job.createdAt,
                  job.state === "RUNNING" && !interrupted
                    ? undefined
                    : job.updatedAt,
                )}
              </span>
              <span>
                进度：{completed} / {job.stages.length}
              </span>
            </div>
            <progress
              aria-label="生成阶段进度"
              max={job.stages.length}
              value={completed}
            />
            {job.error && (
              <p role="alert" className="error">
                {job.error}
              </p>
            )}
            <ol className="generation-stages">
              {job.stages.map((stage) => (
                <li
                  key={stage.id}
                  className={`generation-stage ${stage.state.toLowerCase()}`}
                >
                  <div className="row">
                    <strong>{labels[stage.id]}</strong>
                    <span>
                      {labels[stage.state]} ·{" "}
                      {duration(
                        stage.startedAt,
                        stage.state === "RUNNING"
                          ? interrupted
                            ? job.updatedAt
                            : undefined
                          : stage.endedAt,
                      )}{" "}
                      · 尝试 {stage.attempts}
                    </span>
                  </div>
                  {stage.error && <pre className="error">{stage.error}</pre>}
                  {stage.output !== undefined ? (
                    <details>
                      <summary>查看阶段产物</summary>
                      <pre>{JSON.stringify(stage.output, null, 2)}</pre>
                    </details>
                  ) : (
                    <small>
                      {stage.state === "SKIPPED"
                        ? "本阶段无需产物"
                        : "尚无产物"}
                    </small>
                  )}
                </li>
              ))}
            </ol>
            {job.validation && (
              <details open={job.validation.errors.length > 0}>
                <summary>
                  校验结果 · 阻塞 {job.validation.blockingErrors.length} ·
                  待人工审核 {job.validation.reviewRequired.length}
                </summary>
                <pre>{JSON.stringify(job.validation, null, 2)}</pre>
              </details>
            )}
            {job.state === "NEEDS_REVIEW" ? (
              <button onClick={() => onOpen(job)}>打开草稿</button>
            ) : (
              <button
                disabled={
                  (job.state === "RUNNING" && !interrupted) ||
                  resuming === job.id
                }
                onClick={() => void resume(job)}
              >
                {job.state === "RUNNING" && !interrupted
                  ? "正在生成…"
                  : "继续未完成阶段"}
              </button>
            )}
          </article>
        );
      })}
    </section>
  );
}
