import type { AuthProfile } from "../../../../packages/contracts/src/index";
import { PipelineReview, ScenarioFork } from "./PipelineReview";
import { useEffect, useState } from "react";
import type { Generation } from "../../../../packages/planner/src/workflow";
const labels: Record<string, string> = {
  API_ORGANIZATION: "分批整理接口",
  API_SELECTION: "按场景推荐接口",
  CASE_DESIGN: "生成语义用例",
  PLAN_DESIGN: "生成接口调用计划",
  PLAN_REPAIR: "局部修复调用节点",
  WAITING_INTERFACE_REVIEW: "等待用户确认接口",
  WAITING_CASE_REVIEW: "等待用户确认用例",
  WAITING_CONFIGURATION: "等待补充前置配置",
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
  workspaceId = "",
  recordingId,
  generationId,
}: {
  workspaceId?: string;
  recordingId?: string;
  generationId?: string;
  onOpen: (job: Generation) => void;
}) {
  const [jobs, setJobs] = useState<(Generation & { active?: boolean })[]>([]);
  const [selectedId, setSelectedId] = useState(generationId ?? "");
  const [error, setError] = useState("");
  const [resuming, setResuming] = useState<string>();
  const [profiles, setProfiles] = useState<AuthProfile[]>([]);
  const [authChoices, setAuthChoices] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth-profiles")
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as AuthProfile[];
        if (!cancelled) setProfiles(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [recordingId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch(
          `/api/generations?recordingId=${encodeURIComponent(recordingId!)}${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
        );
        if (!response.ok) throw new Error(await response.text());
        const data = (await response.json()) as (Generation & {
          active?: boolean;
        })[];
        if (!cancelled) {
          setJobs(
            data
              .filter(
                (job) =>
                  job.input.recording.id === recordingId &&
                  (!workspaceId ||
                    job.input.recording.workspaceId === workspaceId),
              )
              .sort((a, b) => b.createdAt - a.createdAt),
          );
          setError("");
        }
      } catch (error) {
        if (!cancelled) setError(String(error));
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 1500);
      }
    };
    if (recordingId) void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workspaceId, recordingId, generationId]);
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
  const regenerate = async (job: Generation) => {
    setResuming(job.id);
    try {
      const response = await fetch(
        `/api/generations/${job.id}/regenerate-plan`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            revision: job.revision,
            authProfileRef: authChoices[job.id] || job.authProfileRef,
          }),
        },
      );
      if (!response.ok) throw new Error(await response.text());
      const fresh = await fetch(`/api/generations/${job.id}`);
      if (!fresh.ok) throw new Error(await fresh.text());
      const next = (await fresh.json()) as Generation;
      setJobs((all) =>
        all.map((item) =>
          item.id === job.id
            ? { ...next, active: next.state === "RUNNING" }
            : item,
        ),
      );
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
      {jobs.length > 1 && (
        <label>
          本次录制的生成历史
          <select
            value={selectedId || jobs[0].id}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {new Date(job.createdAt).toLocaleString()} · {labels[job.state]}{" "}
                · {job.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      )}
      {jobs
        .filter((job) => job.id === (selectedId || jobs[0]?.id))
        .map((job) => {
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
                录制 {job.input.recording.id} · 目标{" "}
                {job.input.recording.target}
                <br />
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
                        : (labels[job.state] ?? "等待执行")}
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
              {job.pipelineVersion === 2 &&
                [
                  "WAITING_INTERFACE_REVIEW",
                  "WAITING_CASE_REVIEW",
                  "WAITING_CONFIGURATION",
                ].includes(job.state) && (
                  <PipelineReview
                    key={`${job.id}:${job.state}`}
                    job={job}
                    onSubmitted={() =>
                      setJobs((all) =>
                        all.map((item) =>
                          item.id === job.id
                            ? { ...item, state: "RUNNING", active: true }
                            : item,
                        ),
                      )
                    }
                  />
                )}
              {job.pipelineVersion === 2 &&
                job.state !== "RUNNING" &&
                job.stages.find((s) => s.id === "API_ORGANIZATION")?.state ===
                  "SUCCEEDED" && (
                  <ScenarioFork
                    key={job.id}
                    job={job}
                    onFork={async (id) => {
                      const response = await fetch(`/api/generations/${id}`);
                      if (!response.ok) throw new Error(await response.text());
                      const next = (await response.json()) as Generation;
                      setJobs((all) => [next, ...all]);
                      setSelectedId(id);
                    }}
                  />
                )}
              {job.catalogSourceGenerationId && (
                <p>
                  接口目录复用自任务 {job.catalogSourceGenerationId.slice(0, 8)}
                  。
                </p>
              )}
              {job.pipelineVersion === 2 && (
                <details>
                  <summary>批次进度与输入预算</summary>
                  <p>
                    输入预算 {job.modelLimits?.inputBudget}；输出上限{" "}
                    {job.modelLimits?.maxOutputTokens}{" "}
                    token。输入为保守字节估算，实际 token 用量以模型日志 usage
                    为准。
                  </p>
                  {[
                    ...(job.organizationBatches ?? []),
                    ...(job.selectionBatches ?? []),
                  ].map((batch) => (
                    <p key={batch.id}>
                      {batch.id} · {batch.apiIds.length} 个接口 ·{" "}
                      {labels[batch.state]} · 尝试 {batch.attempts} · 输入估算{" "}
                      {batch.inputEstimate}
                      {batch.error && ` · ${batch.error}`}
                    </p>
                  ))}
                </details>
              )}
              {job.planCompilerVersion === 2 && job.caseConfirmed && (
                <section>
                  <h4>调用计划编译</h4>
                  <p>
                    模型仅生成调用意图；本地编译器沿用录制请求，组装参数、Header、依赖和执行策略。配置检查不等于已验证登录或接口执行。
                  </p>
                  {job.preflight && (
                    <p>
                      生成前配置检查：
                      {job.preflight.blockers.length ? "待补充" : "通过"}
                    </p>
                  )}
                  {job.preflight?.blockers.map((message) => (
                    <p className="error" key={message}>
                      {message}
                    </p>
                  ))}
                  <label>
                    计划前置 UI 协议
                    <select
                      value={authChoices[job.id] ?? job.authProfileRef ?? ""}
                      disabled={job.active !== false || resuming === job.id}
                      onChange={(event) =>
                        setAuthChoices((all) => ({
                          ...all,
                          [job.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="">请选择前置 UI 协议</option>
                      {profiles
                        .filter(
                          (profile) =>
                            !profile.environmentRef ||
                            profile.environmentRef === job.input.environment.id,
                        )
                        .map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.id}
                          </option>
                        ))}
                    </select>
                  </label>
                  {job.state === "WAITING_CONFIGURATION" && (
                    <p>
                      补充前置 UI
                      配置后，选择对应协议并点击“重新生成计划”，会保留已确认的接口和用例。
                    </p>
                  )}
                  {job.callIntent && (
                    <details>
                      <summary>查看模型调用意图</summary>
                      <pre>{JSON.stringify(job.callIntent, null, 2)}</pre>
                    </details>
                  )}
                </section>
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
                    {stage.id === "PLAN_DESIGN" &&
                      job.pipelineVersion === 2 &&
                      job.caseConfirmed && (
                        <button
                          disabled={job.active !== false || resuming === job.id}
                          onClick={() => void regenerate(job)}
                        >
                          重新生成计划
                        </button>
                      )}
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
              {job.planCompilerVersion === 2 &&
                job.state === "NEEDS_REVIEW" &&
                job.validation && (
                  <p role="status">
                    {job.validation.blockingErrors.length
                      ? `计划待补充：还有 ${job.validation.blockingErrors.length} 项执行条件未满足。`
                      : "计划结构检查通过，等待审核数据和预期；尚未验证实际回放。"}
                  </p>
                )}
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
              ) : ["WAITING_INTERFACE_REVIEW", "WAITING_CASE_REVIEW"].includes(
                  job.state,
                ) ? null : (
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
