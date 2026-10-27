import { AuthSourceHints, applyAuthHints } from "./AuthSourceHints";
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
  onConfigure,
  workspaceId = "",
  recordingId,
  generationId,
}: {
  workspaceId?: string;
  recordingId?: string;
  generationId?: string;
  onOpen: (job: Generation) => void;
  onConfigure?: (job: Generation) => void;
}) {
  const [jobs, setJobs] = useState<(Generation & { active?: boolean })[]>([]);
  const [selectedId, setSelectedId] = useState(generationId ?? "");
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionJobId, setActionJobId] = useState<string>();
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
          setRefreshError("");
        }
      } catch (error) {
        if (!cancelled) setRefreshError(String(error));
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
    setError("");
    setNotice("");
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
  const regenerate = async (job: Generation, authProfileOverride?: string) => {
    setActionJobId(job.id);
    setError("");
    setNotice("");
    setResuming(job.id);
    try {
      const response = await fetch(
        `/api/generations/${job.id}/regenerate-plan`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            revision: job.revision,
            authProfileRef:
              authProfileOverride ?? authChoices[job.id] ?? job.authProfileRef,
          }),
        },
      );
      if (!response.ok) throw new Error(await response.text());
      const fresh = await fetch(`/api/generations/${job.id}`);
      if (!fresh.ok) throw new Error(await fresh.text());
      const next = (await fresh.json()) as Generation & { active?: boolean };
      setJobs((all) =>
        all.map((item) => (item.id === job.id ? { ...next } : item)),
      );
      setNotice(
        next.state === "WAITING_CONFIGURATION"
          ? "配置检查未通过，请按下方提示补充后重新生成。"
          : next.state === "NEEDS_REVIEW"
            ? "计划已重新生成，请审核产物。"
            : "重新生成请求已提交，进度见下方。",
      );
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
          操作失败：{error}
        </p>
      )}
      {refreshError && (
        <p className="error" role="alert">
          刷新失败：{refreshError}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
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
          const actionBusy =
            (job.state === "RUNNING" && job.active === true) ||
            resuming === job.id;
          const selectedProfile = profiles.find(
            (profile) =>
              profile.id === (authChoices[job.id] ?? job.authProfileRef),
          );
          const missingHeaderNames = [
            ...new Set(
              (job.preflight?.blockers ?? []).flatMap(
                (message) =>
                  message.match(/^认证 Header ([A-Za-z0-9_-]+)/)?.[1] ?? [],
              ),
            ),
          ];
          const relevantHints = (job.input.recording.authHints ?? []).filter(
            (hint) =>
              missingHeaderNames.some(
                (name) => name.toLowerCase() === hint.header.toLowerCase(),
              ),
          );
          const busyReason =
            resuming === job.id
              ? "正在提交操作，请稍候"
              : "当前任务仍在运行，完成后可重新生成";
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
              {job.state === "RUNNING" && job.active === undefined && (
                <p>运行状态尚未确认，重新生成时将由后端检查。</p>
              )}
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
                  {job.state === "WAITING_CONFIGURATION" && (
                    <div className="generation-blocked" aria-live="polite">
                      <strong>
                        请求已处理，但尚未开始生成计划：前置认证配置未通过。
                      </strong>
                      <p>
                        这里还没有调用大模型。请补充当前协议的认证来源，或选择实际录制的前置
                        UI 协议后再生成。
                      </p>
                      {job.preflight?.blockers.map((message) => (
                        <p key={message}>{message}</p>
                      ))}
                      {missingHeaderNames.map((header) => {
                        const requests = job.input.recording.requests.filter(
                          (request) =>
                            Object.keys(request.headers).some(
                              (name) =>
                                name.toLowerCase() === header.toLowerCase(),
                            ),
                        );
                        return (
                          <details key={header}>
                            <summary>
                              查看 {header} 的录制证据（{requests.length}{" "}
                              条请求）
                            </summary>
                            {requests.slice(0, 5).map((request) => (
                              <p key={request.id}>
                                {request.method} {request.url} · 请求{" "}
                                {request.id}（已隐藏 Header 值）
                              </p>
                            ))}
                            {!requests.length && (
                              <p>
                                当前录制没有该 Header
                                的请求证据，请重新分析或生成，不能按旧目录猜测来源。
                              </p>
                            )}
                          </details>
                        );
                      })}
                      {onConfigure && (
                        <button type="button" onClick={() => onConfigure(job)}>
                          前往配置录制前置 UI
                        </button>
                      )}
                    </div>
                  )}
                  {job.state === "WAITING_CONFIGURATION" && (
                    <AuthSourceHints
                      hints={relevantHints}
                      disabled={actionBusy || !selectedProfile}
                      onApply={(hints) =>
                        void (async () => {
                          if (!selectedProfile) return;
                          setActionJobId(job.id);
                          setResuming(job.id);
                          setError("");
                          try {
                            const updated = applyAuthHints(
                              selectedProfile,
                              hints,
                            );
                            const response = await fetch("/api/auth-profiles", {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify(updated),
                            });
                            if (!response.ok)
                              throw new Error(await response.text());
                            const saved =
                              (await response.json()) as AuthProfile;
                            setProfiles((all) =>
                              all.map((profile) =>
                                profile.id === saved.id ? saved : profile,
                              ),
                            );
                            await regenerate(job, saved.id);
                          } catch (error) {
                            setError(String(error));
                          } finally {
                            setResuming(undefined);
                          }
                        })()
                      }
                    />
                  )}

                  <label>
                    计划前置 UI 协议
                    <select
                      value={authChoices[job.id] ?? job.authProfileRef ?? ""}
                      disabled={actionBusy}
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
                          type="button"
                          disabled={actionBusy}
                          title={
                            actionBusy
                              ? busyReason
                              : "保留已确认用例，重新生成调用计划及后续校验"
                          }
                          onClick={() => void regenerate(job)}
                        >
                          {resuming === job.id ? "正在提交…" : "重新生成计划"}
                        </button>
                      )}
                    {stage.id === "PLAN_DESIGN" && actionJobId === job.id && (
                      <p
                        aria-live="polite"
                        className={
                          job.state === "WAITING_CONFIGURATION" || error
                            ? "error"
                            : ""
                        }
                      >
                        {resuming === job.id
                          ? "正在提交请求并检查前置配置…"
                          : error
                            ? `操作失败：${error}`
                            : job.state === "WAITING_CONFIGURATION"
                              ? "本次未开始生成：认证配置仍待补充，请查看上方认证提示。"
                              : job.state === "RUNNING"
                                ? `请求已受理，当前阶段：${current ? labels[current.id] : "正在检查或启动"}`
                                : "本次请求已完成，请查看阶段产物和校验结果。"}
                      </p>
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
