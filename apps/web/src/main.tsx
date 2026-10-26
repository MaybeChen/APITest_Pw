import { RecordingHistory } from "./components/RecordingHistory";
import type { Generation } from "../../../packages/planner/src/workflow";
import { Datasets } from "./components/Datasets";
import { GenerationProgress } from "./components/GenerationProgress";
import { Workflow } from "./components/Workflow";
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type {
  TestCase,
  Plan,
  Asset,
  Recording,
  Report,
  Environment,
  AuthProfile,
} from "../../../packages/contracts/src/index";
import "./style.css";
import {
  RequestDetails,
  requestCategoryLabel,
} from "./components/RequestDetails";
import { EnvironmentForm } from "./components/EnvironmentForm";
type Analysis = { recording: Recording; assets: Asset[] };
const flowSteps = ["浏览器录制", "分析与筛选", "生成草稿", "用例编辑"];
const stepNames = ["录制操作", "分析筛选", "生成草稿", "审核与执行"];
type Bundle = { testCase: TestCase; plan: Plan; assets: Asset[] };
async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const r = await fetch(
    "/api" + path,
    body === undefined
      ? { method: method ?? "GET" }
      : {
          method: method ?? "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = r.status === 204 ? undefined : await r.json();
  if (!r.ok) throw new Error(data.error ?? "请求失败");
  return data;
}
function preference(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Preferences are optional; server data remains persistent. */
  }
}
function App() {
  const [tab, setActiveTab] = useState("浏览器录制"),
    [flowTab, setFlowTab] = useState("浏览器录制"),
    [generations, setGenerations] = useState<Generation[]>([]),
    [analyses, setAnalyses] = useState<Analysis[]>([]),
    [generationId, setGenerationId] = useState<string>(),
    [aiProvider, setAIProvider] = useState<{
      provider: string;
      model: string;
    }>(),
    [workspaceId, setWorkspaceId] = useState(() =>
      preference("tracepilot.workspaceId", ""),
    ),
    [drafts, setDrafts] = useState<Bundle[]>([]),
    [cases, setCases] = useState<TestCase[]>([]),
    [plans, setPlans] = useState<Plan[]>([]),
    [recordings, setRecordings] = useState<Recording[]>([]),
    [reports, setReports] = useState<Report[]>([]),
    [bundle, setBundle] = useState<Bundle>(),
    [raw, setRaw] = useState(""),
    [recording, setRecording] = useState<Recording>(),
    [analysis, setAnalysis] = useState<{
      recording: Recording;
      assets: Asset[];
    }>(),
    [report, setReport] = useState<Report>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [view, setView] = useState("语义用例"),
    [selection, setSelection] = useState(""),
    [configText, setConfigText] = useState(""),
    [creatingEnvironment, setCreatingEnvironment] = useState(false),
    [configKind, setConfigKind] = useState(() =>
      preference("tracepilot.configKind", "environments"),
    ),
    [configId, setConfigId] = useState(() =>
      preference("tracepilot.configId", ""),
    ),
    [configDirty, setConfigDirty] = useState(false),
    [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]),
    [environments, setEnvironments] = useState<Environment[]>([]),
    [environmentRef, setEnvironmentRef] = useState(() =>
      preference("tracepilot.environmentRef", "demo"),
    ),
    [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const inFlow = flowSteps.includes(tab);
  const currentPage = inFlow ? "用例流程" : tab;
  const setTab = (next: string) => {
    setActiveTab(next);
    if (flowSteps.includes(next)) setFlowTab(next);
  };
  const clearFlow = () => {
    setRecording(undefined);
    setAnalysis(undefined);
    setBundle(undefined);
    setRaw("");
    setReport(undefined);
    setSelection("");
    setGenerationId(undefined);
    setError("");
    setNotice("");
    setFlowTab("浏览器录制");
  };
  const newFlow = () => {
    if (recording?.state === "RECORDING") {
      setTab("浏览器录制");
      setNotice("请先停止当前录制，再开始新的流程。");
      return;
    }
    clearFlow();
    setTab("浏览器录制");
  };
  const openRecording = (r: Recording) =>
    void task(async () => {
      clearFlow();
      setRecording(r);
      if (r.environmentRef) setEnvironmentRef(r.environmentRef);
      const [jobs, savedAnalysis] = await Promise.all([
        api<Generation[]>(
          `/generations?recordingId=${encodeURIComponent(r.id)}${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
        ),
        api<Analysis | null>(
          `/recordings/${encodeURIComponent(r.id)}/analysis`,
        ),
      ]);
      const job = jobs
        .filter((j) => j.input.recording.id === r.id)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      setAnalysis(savedAnalysis ?? undefined);
      if (job) {
        if (!r.environmentRef)
          setEnvironmentRef(job.input.environment?.id ?? environmentRef);
        setGenerationId(job.id);
        if (job.testCase && job.plan && job.state === "NEEDS_REVIEW") {
          const draft = drafts.find(
            (d) => d.testCase.caseId === job.testCase!.caseId,
          );
          const approved = cases.find((c) => c.caseId === job.testCase!.caseId);
          const plan =
            approved &&
            plans.find(
              (p) =>
                p.caseId === approved.caseId &&
                p.caseVersion === approved.version,
            );
          edit(
            approved && plan
              ? {
                  testCase: approved,
                  plan,
                  assets: await api<Asset[]>("/assets"),
                }
              : (draft ?? {
                  testCase: job.testCase,
                  plan: job.plan,
                  assets: job.input.assets,
                }),
          );
          setTab("用例编辑");
        } else setTab("生成草稿");
      } else setTab(savedAnalysis ? "分析与筛选" : "浏览器录制");
    });
  const changeStep = (index: number) => {
    if (index === 1 && recording && !analysis) {
      void task(async () => {
        setAnalysis(
          await api<Analysis>(`/recordings/${recording.id}/analyze`, {}),
        );
        setTab("分析与筛选");
      });
    } else setTab(flowSteps[index]);
  };
  const workspaceCases = cases.filter(
    (c) => !workspaceId || c.workspaceId === workspaceId,
  );
  const workspaceRecordings = recordings.filter(
    (r) => !workspaceId || r.workspaceId === workspaceId,
  );
  const workspaceReports = reports.filter(
    (r) =>
      !workspaceId ||
      workspaceCases.some((c) => c.caseId === r.caseId) ||
      generations.some(
        (j) =>
          j.input.recording.workspaceId === workspaceId &&
          j.testCase?.caseId === r.caseId,
      ),
  );
  const refresh = async () => {
    const [c, p, r, re, w, en, dr, profiles, ai, jobs, savedAnalyses] =
      await Promise.all([
        api<TestCase[]>("/cases"),
        api<Plan[]>("/plans"),
        api<Recording[]>("/recordings"),
        api<Report[]>("/reports"),
        api<{ id: string; name: string }[]>("/workspaces"),
        api<Environment[]>("/environments"),
        api<Bundle[]>("/drafts"),
        api<AuthProfile[]>("/auth-profiles"),
        api<{ provider: string; model: string }>("/ai-provider"),
        api<Generation[]>("/generations"),
        api<Analysis[]>("/analyses"),
      ]);
    setGenerations(jobs);
    setAnalyses(savedAnalyses);
    setAIProvider(ai);
    setAuthProfiles(profiles);
    setDrafts(dr);
    setCases(c);
    setPlans(p);
    setRecordings(r);
    setReports(re);
    setWorkspaces(w);
    setEnvironments(en);
    setEnvironmentRef((current) =>
      en.some((e) => e.id === current) ? current : (en[0]?.id ?? "demo"),
    );
    setWorkspaceId((current) =>
      w.some((item) => item.id === current) ? current : "",
    );
  };
  useEffect(() => {
    remember("tracepilot.workspaceId", workspaceId);
  }, [workspaceId]);
  useEffect(() => {
    remember("tracepilot.environmentRef", environmentRef);
  }, [environmentRef]);
  useEffect(() => {
    remember("tracepilot.configKind", configKind);
    remember("tracepilot.configId", configId);
    if (configDirty) return;
    const items = configKind === "environments" ? environments : authProfiles;
    const selected =
      items.find((item) => item.id === configId) ??
      items.find((item) => item.id === environmentRef) ??
      items[0];
    if (selected) {
      setConfigId(selected.id);
      setConfigText(JSON.stringify(selected, null, 2));
    }
  }, [
    configKind,
    configId,
    environmentRef,
    environments,
    authProfiles,
    configDirty,
  ]);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  const task = async (fn: () => Promise<void>) => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const edit = (b: Bundle) => {
    setBundle(b);
    setRaw(JSON.stringify(b, null, 2));
  };
  const loadDemo = () =>
    task(async () => {
      clearFlow();
      const b = await api<Bundle>("/demo", {});
      b.testCase.workspaceId = workspaceId || undefined;
      edit(b);
      setTab("用例编辑");
      setNotice(
        "演示契约模板已载入；请检查业务预期和断言并确认。此模板不是 AI 分析结果。",
      );
    });
  const runPlan = (p: Plan) =>
    task(async () => {
      setReport(
        await api<Report>("/run", { planId: p.planId, version: p.version }),
      );
      setTab("运行报告");
    });
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="#">
          ◈ TracePilot
        </a>
        <p className="eyebrow">API AUTOMATION STUDIO</p>
        <nav>
          {["用例流程", "历史记录", "运行报告", "配置"].map((page, i) => (
            <button
              key={page}
              aria-label={page}
              className={currentPage === page ? "active" : ""}
              onClick={() => {
                if (page === "用例流程") setTab(flowTab);
                else {
                  setTab(page);
                  void refresh().catch((e) => setError(String(e)));
                }
              }}
            >
              <span>0{i + 1}</span>
              {page}
            </button>
          ))}
        </nav>
        <div className="aside-note">
          <b>确定性执行</b>
          <p>AI 提出建议，人工审核批准。每次回归使用固定计划。</p>
          <small>LOCAL DEVELOPMENT · v0.1</small>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">TRACEPILOT / {currentPage}</p>
            <h1>{currentPage}</h1>
          </div>
          <span className="badge">
            {aiProvider
              ? `${aiProvider.provider} · ${aiProvider.model}`
              : "加载模型配置…"}
          </span>
        </header>
        <p className="subtitle">
          从浏览器中的业务流程，到可追溯的 API 回归测试。
        </p>
        <div className="context-bar">
          <label>
            当前工作区{" "}
            <select
              aria-label="当前工作区"
              value={workspaceId}
              disabled={busy || recording?.state === "RECORDING"}
              onChange={(e) => {
                clearFlow();
                setWorkspaceId(e.target.value);
                if (inFlow) setTab("浏览器录制");
              }}
            >
              <option value="">全部工作区</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <span>
            {inFlow
              ? recording
                ? `当前记录：${recording.caseName}`
                : bundle
                  ? `当前草稿：${bundle.testCase.name}`
                  : "新建录制流程"
              : "按工作区查看记录与产物"}
          </span>
        </div>
        {inFlow && (
          <section className="flow-panel">
            <div className="row">
              <div>
                <strong className="flow-title">
                  {recording?.caseName ??
                    bundle?.testCase.name ??
                    "新建录制流程"}
                </strong>
                <p>
                  {recording
                    ? `录制 ID：${recording.id} · ${recording.target}`
                    : "录制、分析、生成和审核在同一条流程中完成。"}
                </p>
              </div>
              <button
                className="secondary"
                disabled={busy || recording?.state === "RECORDING"}
                onClick={newFlow}
              >
                新建录制流程
              </button>
            </div>
            <ol className="flow-steps" aria-label="用例流程进度">
              {flowSteps.map((step, i) => (
                <li key={step}>
                  <button
                    aria-current={tab === step ? "step" : undefined}
                    className={tab === step ? "active" : "secondary"}
                    disabled={
                      busy ||
                      (i > 0 && recording?.state === "RECORDING") ||
                      (i === 1 && recording?.state !== "STOPPED") ||
                      (i === 2 && !generationId) ||
                      (i === 3 && !bundle)
                    }
                    onClick={() => changeStep(i)}
                  >
                    <span>{i + 1}</span>
                    {stepNames[i]}
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}
        {busy && (
          <div role="status" className="message">
            正在处理，请稍候…
          </div>
        )}
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {notice && <div className="message">{notice}</div>}
        {tab === "历史记录" && (
          <>
            <div className="stats">
              {[
                ["已批准版本", workspaceCases.length],
                ["录制记录", workspaceRecordings.length],
                ["历史运行", workspaceReports.length],
              ].map(([k, v]) => (
                <article key={k}>
                  <small>{k}</small>
                  <strong>{v}</strong>
                </article>
              ))}
            </div>
            <section className="hero">
              <div>
                <span className="eyebrow">START WITH EVIDENCE</span>
                <h2>让真实操作成为测试证据</h2>
                <p>录制业务流程，审查语义与执行计划，再进行隔离回放。</p>
              </div>
              <button disabled={busy} onClick={newFlow}>
                新建录制流程
              </button>
              <button
                className="secondary"
                disabled={busy || recording?.state === "RECORDING"}
                onClick={loadDemo}
              >
                载入订单演示模板
              </button>
            </section>
            <RecordingHistory
              recordings={workspaceRecordings}
              generations={generations}
              analyzedIds={new Set(analyses.map((a) => a.recording.id))}
              approvedCaseIds={new Set(cases.map((c) => c.caseId))}
              busy={busy || recording?.state === "RECORDING"}
              onOpen={openRecording}
            />
            <details>
              <summary>未关联录制的模板与旧用例</summary>{" "}
              <section>
                <h2>草稿历史</h2>
                {drafts
                  .filter(
                    (b, i, a) =>
                      a.findIndex(
                        (x) => x.testCase.caseId === b.testCase.caseId,
                      ) === i,
                  )
                  .filter(
                    (b) =>
                      !workspaceId || b.testCase.workspaceId === workspaceId,
                  )
                  .filter(
                    (b) =>
                      !generations.some(
                        (j) => j.testCase?.caseId === b.testCase.caseId,
                      ),
                  )
                  .map((b) => (
                    <button
                      className="secondary"
                      key={b.testCase.caseId}
                      onClick={() => {
                        clearFlow();
                        edit(b);
                        setTab("用例编辑");
                      }}
                    >
                      {b.testCase.name} · 草稿
                    </button>
                  ))}
              </section>
              <section>
                <h2>测试用例</h2>
                {!cases.length ? (
                  <p className="empty">
                    尚无已批准用例。录制业务流程，或载入演示模板开始。
                  </p>
                ) : (
                  cases
                    .filter(
                      (c) => !workspaceId || c.workspaceId === workspaceId,
                    )
                    .filter(
                      (c) =>
                        !generations.some(
                          (j) => j.testCase?.caseId === c.caseId,
                        ),
                    )
                    .map((c) => (
                      <div className="row" key={`${c.caseId}:${c.version}`}>
                        <div>
                          <b>{c.name}</b>
                          <p>
                            Case v{c.version} · {c.status} · 最近结果：
                            {reports.find((r) => r.caseId === c.caseId)
                              ?.status ?? "未运行"}
                          </p>
                        </div>
                        <div>
                          {plans
                            .filter(
                              (p) =>
                                p.caseId === c.caseId &&
                                p.caseVersion === c.version,
                            )
                            .map((p) => (
                              <React.Fragment key={`${p.planId}:${p.version}`}>
                                <button
                                  className="secondary"
                                  onClick={() =>
                                    void task(async () => {
                                      clearFlow();
                                      edit({
                                        testCase: c,
                                        plan: p,
                                        assets: await api<Asset[]>("/assets"),
                                      });
                                      setTab("用例编辑");
                                    })
                                  }
                                >
                                  查看 Plan v{p.version}
                                </button>
                                <button
                                  disabled={
                                    busy ||
                                    Object.keys(p.parameters ?? {}).length > 0
                                  }
                                  onClick={() => runPlan(p)}
                                >
                                  回放 v{p.version}
                                </button>
                              </React.Fragment>
                            ))}
                        </div>
                      </div>
                    ))
                )}
              </section>
            </details>
          </>
        )}
        {tab === "浏览器录制" && (
          <>
            {!recording && (
              <section>
                <h2>新建录制会话</h2>
                <p>
                  默认连接本地订单演示站点。可见浏览器需要桌面显示环境；云端测试使用
                  headless 模式。
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const d = new FormData(e.currentTarget);
                    void task(async () => {
                      setRecording(
                        await api<Recording>("/recordings", {
                          ...Object.fromEntries(d),
                          environmentRef,
                          workspaceId: workspaceId || undefined,
                        }),
                      );
                    });
                  }}
                >
                  <label>
                    用例名称
                    <input
                      required
                      name="caseName"
                      placeholder="删除订单成功"
                    />
                  </label>
                  <label>
                    测试场景
                    <textarea
                      required
                      name="scenario"
                      placeholder="描述操作目标与预期业务结果"
                    />
                  </label>
                  <label>
                    执行环境
                    <select
                      value={environmentRef}
                      onChange={(e) => setEnvironmentRef(e.target.value)}
                    >
                      {environments.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.id} · {e.baseURL}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    目标站点
                    <input
                      required
                      name="target"
                      defaultValue="http://127.0.0.1:3100"
                    />
                  </label>
                  <label>
                    录制说明
                    <input name="notes" />
                  </label>
                  <button disabled={busy}>开始录制</button>
                </form>
              </section>
            )}
            {recording && (
              <section>
                <div className="row">
                  <h2>
                    {recording.caseName}{" "}
                    <span className="badge">{recording.state}</span>
                  </h2>
                  <div>
                    <button
                      className="secondary"
                      onClick={() =>
                        void task(async () =>
                          setRecording(
                            await api<Recording>("/recordings/" + recording.id),
                          ),
                        )
                      }
                    >
                      刷新事件
                    </button>
                    {recording.state === "RECORDING" ? (
                      <button
                        onClick={() =>
                          void task(async () => {
                            const stopped = await api<Recording>(
                              `/recordings/${recording.id}/stop`,
                              {},
                            );
                            setRecording(stopped);
                            setAnalysis(
                              await api<Analysis>(
                                `/recordings/${stopped.id}/analyze`,
                                {},
                              ),
                            );
                            setTab("分析与筛选");
                          })
                        }
                      >
                        停止并保存
                      </button>
                    ) : (
                      <button
                        onClick={() =>
                          void task(async () => {
                            setAnalysis(
                              await api(
                                "/recordings/" + recording.id + "/analyze",
                                {},
                              ),
                            );
                            setTab("分析与筛选");
                          })
                        }
                      >
                        分析录制
                      </button>
                    )}
                  </div>
                </div>
                <p>
                  已录制 {recording.operations.length} 个操作、
                  {recording.contextSnapshots?.length ??
                    0} 份页面摘要；脚本就绪{" "}
                  {recording.contextCapture?.initializedFrames ?? "未记录"}{" "}
                  个页面/框架。
                </p>
                {!recording.operations.length && (
                  <p role="alert">
                    尚未采集到页面操作。请在录制浏览器内操作后刷新事件；若仍为
                    0，请检查后端版本并重新录制。
                  </p>
                )}
                {!!recording.contextCapture?.rejectedEvents && (
                  <p role="alert">
                    有 {recording.contextCapture.rejectedEvents}{" "}
                    条上下文事件未通过校验。
                  </p>
                )}
                <h3>操作时间线</h3>
                {recording.operations.map((o) => (
                  <details key={o.id}>
                    <summary>
                      {new Date(o.at).toLocaleTimeString()} · {o.type}
                    </summary>
                    <pre>{JSON.stringify(o.context, null, 2)}</pre>
                  </details>
                ))}
                <h3>网络请求</h3>
                {recording.requests.map((r) => (
                  <details key={r.id}>
                    <summary>
                      {r.method} {r.url} · {r.status ?? "等待中"}
                    </summary>
                    <RequestDetails
                      request={r}
                      snapshots={recording?.contextSnapshots}
                    />
                  </details>
                ))}
              </section>
            )}
          </>
        )}
        {tab === "分析与筛选" && (
          <section>
            <h2>候选请求与证据</h2>

            {!analysis ? (
              <p className="empty">先停止录制并执行分析。</p>
            ) : (
              <>
                <p>
                  当前展示的是规则分析，不是大模型分析。非 /api/ 路径的
                  Fetch/XHR 默认保留为待确认接口，生成双产物草稿时才调用模型。
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const d = new FormData(e.currentTarget);
                    void task(async () =>
                      setAnalysis(
                        await api(
                          "/recordings/" + analysis.recording.id + "/analyze",
                          {
                            pathPattern: d.get("pathPattern"),
                            domains: String(d.get("domains") ?? "")
                              .split(",")
                              .filter(Boolean),
                            methods: String(d.get("methods") ?? "")
                              .split(",")
                              .filter(Boolean),
                            resourceTypes: String(d.get("resourceTypes") ?? "")
                              .split(",")
                              .filter(Boolean),
                          },
                        ),
                      ),
                    );
                  }}
                >
                  <input name="pathPattern" placeholder="排除路径包含" />
                  <input name="domains" placeholder="排除域名，逗号分隔" />
                  <input name="methods" placeholder="排除 Method" />
                  <input name="resourceTypes" placeholder="排除资源类型" />
                  <button>应用过滤</button>
                </form>
                <p role="status">
                  共 {analysis.recording.requests.length} 个请求，已保留{" "}
                  {analysis.recording.requests.filter((r) => r.keep).length}{" "}
                  个，已排除{" "}
                  {analysis.recording.requests.filter((r) => !r.keep).length}{" "}
                  个。
                </p>
                {!analysis.recording.requests.some((r) => r.keep) && (
                  <div className="message">
                    {analysis.recording.requests.length
                      ? "请勾选需要的业务请求；如为旧分析结果，请重新点击录制会话的“分析录制”。登录请求不能作为业务步骤。"
                      : "没有录到 Fetch/XHR，请检查请求域名白名单，并在录制期间完成业务操作后重新录制。"}
                  </div>
                )}
                {analysis.recording.requests.map((r) => (
                  <details key={r.id}>
                    <summary>
                      <input
                        aria-label={"保留 " + r.url}
                        type="checkbox"
                        checked={!!r.keep}
                        disabled={r.category === "AUTH_BOOTSTRAP"}
                        onChange={(e) => {
                          const a = structuredClone(analysis);
                          a.recording.requests.find(
                            (q) => q.id === r.id,
                          )!.keep = e.target.checked;
                          setAnalysis(a);
                        }}
                      />
                      {r.method} {new URL(r.url).pathname}{" "}
                      <span className="badge" title={r.category}>
                        {requestCategoryLabel(r.category)}
                      </span>
                    </summary>
                    <p>
                      {r.keep ? "已保留" : "已排除"} ·{" "}
                      {r.classification?.reason} · 置信度{" "}
                      {r.classification?.confidence}
                    </p>
                    <RequestDetails
                      request={r}
                      snapshots={
                        (analysis?.recording ?? recording)?.contextSnapshots
                      }
                    />
                    <h3>候选依赖与操作关联</h3>
                    <pre>
                      {JSON.stringify(
                        {
                          dependencies: analysis.recording.dependencies.filter(
                            (d) => d.to === r.id,
                          ),
                          associations: r.operationCandidates,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ))}
                <details>
                  <summary>接口资产、Header 策略与依赖候选</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        assets: analysis.assets,
                        dependencies: analysis.recording.dependencies,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <button
                  disabled={
                    busy ||
                    !analysis.recording.requests.some(
                      (r) => r.keep && r.category !== "AUTH_BOOTSTRAP",
                    )
                  }
                  onClick={() =>
                    void task(async () => {
                      const selected = await api<Analysis>(
                        `/recordings/${analysis.recording.id}/analyze`,
                        {
                          overrides: Object.fromEntries(
                            analysis.recording.requests.map((r) => [
                              r.id,
                              !!r.keep,
                            ]),
                          ),
                        },
                      );
                      setAnalysis(selected);
                      const job = await api<{ id: string }>("/generations", {
                        ...selected,
                        environmentRef:
                          recording?.environmentRef ?? environmentRef,
                      });
                      setGenerationId(job.id);
                      setTab("生成草稿");
                      setNotice(
                        "生成已启动，阶段结果自动保存在当前录制记录下。",
                      );
                    })
                  }
                >
                  启动生成工作流
                </button>
              </>
            )}
          </section>
        )}
        {tab === "生成草稿" && recording && (
          <>
            <GenerationProgress
              key={`${workspaceId}:${recording?.id}:${generationId}`}
              recordingId={recording?.id}
              generationId={generationId}
              workspaceId={workspaceId}
              onOpen={(job) => {
                if (job.testCase && job.plan) {
                  edit({
                    testCase: job.testCase,
                    plan: job.plan,
                    assets: job.input.assets,
                  });
                  setTab("用例编辑");
                }
              }}
            />
          </>
        )}
        {tab === "用例编辑" &&
          (!bundle ? (
            <section className="empty">
              还没有草稿。<button onClick={loadDemo}>载入演示模板</button>
            </section>
          ) : (
            <>
              <div className="toolbar">
                {["语义用例", "执行计划", "JSON 编辑"].map((v) => (
                  <button
                    className={view === v ? "" : "secondary"}
                    key={v}
                    onClick={() => setView(v)}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <section>
                <div className="row">
                  <h2>{bundle.testCase.name}</h2>
                  <span className="badge">
                    Case v{bundle.testCase.version} / Plan v
                    {bundle.plan.version} · {bundle.plan.status}
                  </span>
                </div>
                {view === "语义用例" ? (
                  <>
                    <p>{bundle.testCase.objective}</p>
                    <h3>前置条件</h3>
                    <ul>
                      {bundle.testCase.preconditions.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                    {bundle.testCase.steps.map((s, i) => (
                      <article
                        className={
                          "step " + (selection === s.id ? "selected" : "")
                        }
                        key={s.id}
                      >
                        <span className="number">{i + 1}</span>
                        <div>
                          <h3>{s.title}</h3>
                          <p>预期：{s.expected}</p>
                          <small>{s.review}</small>
                        </div>
                        <button
                          className="secondary"
                          onClick={() => {
                            setSelection(s.id);
                            setView("执行计划");
                          }}
                        >
                          定位执行步骤 →
                        </button>
                      </article>
                    ))}
                    <p>整体预期：{bundle.testCase.expected}</p>
                  </>
                ) : view === "执行计划" ? (
                  <>
                    <Workflow plan={bundle.plan} />

                    <p>
                      环境 {bundle.plan.environmentRef} · UI 认证{" "}
                      {bundle.plan.authProfileRef} · Cleanup{" "}
                      {bundle.plan.cleanupPolicy}
                    </p>
                    {bundle.plan.steps
                      .filter(
                        (s) => !selection || s.semanticStepRef === selection,
                      )
                      .map((s) => (
                        <details key={s.id} open>
                          <summary>
                            {s.id} · {s.phase} ·{" "}
                            {
                              bundle.assets.find((a) => a.apiId === s.apiId)
                                ?.method
                            }{" "}
                            {
                              bundle.assets.find((a) => a.apiId === s.apiId)
                                ?.pathTemplate
                            }
                          </summary>
                          <p>依赖：{s.dependsOn.join(" → ") || "起点"}</p>
                          <pre>
                            {JSON.stringify(
                              {
                                path: s.path,
                                query: s.query,
                                body: s.body,
                                headers: s.headers,
                                extract: s.extract,
                                assertions: s.assertions,
                              },
                              null,
                              2,
                            )}
                          </pre>
                          <button
                            className="secondary"
                            onClick={() => {
                              setSelection(s.semanticStepRef);
                              setView("语义用例");
                            }}
                          >
                            返回语义步骤
                          </button>
                        </details>
                      ))}
                    <button
                      className="secondary"
                      onClick={() => setSelection("")}
                    >
                      显示全部步骤
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      编辑完整双产物。修改已批准版本时，必须增加 Case/Plan
                      版本并更新关联；应用后会重新校验。
                    </p>
                    <textarea
                      className="json"
                      aria-label="双产物 JSON"
                      value={raw}
                      onChange={(e) => setRaw(e.target.value)}
                    />
                    <button
                      onClick={() =>
                        void task(async () => {
                          const b = JSON.parse(raw) as Bundle;
                          if (
                            JSON.stringify(b.testCase.steps) !==
                              JSON.stringify(bundle.testCase.steps) ||
                            JSON.stringify(b.plan.steps) !==
                              JSON.stringify(bundle.plan.steps) ||
                            JSON.stringify(b.plan.parameters) !==
                              JSON.stringify(bundle.plan.parameters)
                          ) {
                            b.testCase.status = "DRAFT";
                            b.plan.status = "DRAFT";
                            b.testCase.steps.forEach(
                              (s) => (s.review = "NEEDS_REVIEW"),
                            );
                            b.plan.steps.forEach((s) =>
                              s.assertions.forEach(
                                (a) => (a.confirmed = false),
                              ),
                            );
                          }
                          const result = await api<{ errors: string[] }>(
                            "/validate",
                            b,
                          );
                          edit(b);
                          setNotice(
                            result.errors.length
                              ? result.errors.join("；")
                              : "结构校验通过；仍需人工确认预期。",
                          );
                        })
                      }
                    >
                      应用编辑并检查一致性
                    </button>
                  </>
                )}
                <Datasets
                  key={`${bundle.plan.planId}:${bundle.plan.version}`}
                  plan={bundle.plan}
                  busy={busy}
                  onChange={(plan) =>
                    edit({
                      ...bundle,
                      plan,
                      testCase: { ...bundle.testCase, status: "DRAFT" },
                    })
                  }
                  onReports={(results) => {
                    setReport(results[0]);
                    setReports((all) => [...results, ...all]);
                    setTab("运行报告");
                    setNotice(
                      `已执行 ${results.length} 组数据，通过 ${results.filter((r) => r.status === "PASSED").length} 组。`,
                    );
                  }}
                />
                <div className="toolbar">
                  <button
                    className="secondary"
                    disabled={busy || bundle.plan.status === "APPROVED"}
                    onClick={() =>
                      void task(async () => {
                        edit(await api<Bundle>("/drafts", bundle));
                        setNotice("草稿已保存，可从历史记录重新打开。");
                      })
                    }
                  >
                    保存草稿
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      const b = structuredClone(bundle);
                      b.testCase.version++;
                      b.plan.version++;
                      b.plan.caseVersion = b.testCase.version;
                      b.testCase.planVersions = [b.plan.version];
                      b.testCase.status = "DRAFT";
                      b.plan.status = "DRAFT";
                      b.testCase.steps.forEach(
                        (s) => (s.review = "NEEDS_REVIEW"),
                      );
                      b.plan.steps.forEach((s) =>
                        s.assertions.forEach((a) => (a.confirmed = false)),
                      );
                      edit(b);
                      setNotice("已创建新版本草稿；旧版本保留。");
                    }}
                  >
                    创建新版本
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void task(async () => {
                        const r = await api<{ errors: string[] }>(
                          "/validate",
                          bundle,
                        );
                        setNotice(
                          r.errors.length
                            ? r.errors.join("；")
                            : "计划校验通过",
                        );
                      })
                    }
                  >
                    校验计划
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      const b = structuredClone(bundle);
                      b.testCase.steps.forEach((s) => (s.review = "CONFIRMED"));
                      b.plan.steps.forEach((s) =>
                        s.assertions.forEach((a) => (a.confirmed = true)),
                      );
                      b.assets.forEach((a) => {
                        a.validated = true;
                        a.evidence.confirmed = true;
                      });
                      edit(b);
                      setNotice(
                        "已标记人工确认；请检查全部业务预期，确认无误后批准。",
                      );
                    }}
                  >
                    我已审查预期、断言与资产
                  </button>
                  <button
                    disabled={busy || bundle.plan.status === "APPROVED"}
                    onClick={() =>
                      void task(async () => {
                        edit(
                          await api<Bundle>("/approve", {
                            ...bundle,
                            confirmed: true,
                          }),
                        );
                        setNotice("该版本已批准并以不可覆盖记录保存。");
                      })
                    }
                  >
                    批准并保存版本
                  </button>
                  {bundle.plan.status === "APPROVED" && (
                    <button
                      disabled={
                        busy ||
                        Object.keys(bundle.plan.parameters ?? {}).length > 0
                      }
                      onClick={() => runPlan(bundle.plan)}
                    >
                      执行回放
                    </button>
                  )}
                </div>
              </section>
            </>
          ))}
        {tab === "运行报告" && (
          <>
            <section>
              <h2>历史运行</h2>
              {!workspaceReports.length && (
                <p className="empty">尚无运行报告。</p>
              )}
              {workspaceReports.map((r) => (
                <button
                  className="secondary"
                  key={r.id}
                  onClick={() => setReport(r)}
                >
                  {r.dataset && `${r.dataset.rowName} · `}
                  {r.status} · {new Date(r.startedAt).toLocaleString()}
                </button>
              ))}
            </section>
            {report && (
              <section>
                <div className="row">
                  <h2>
                    运行结果{" "}
                    <span className={"badge " + report.status.toLowerCase()}>
                      {report.status}
                    </span>
                  </h2>
                  <span>{report.endedAt - report.startedAt} ms</span>
                </div>
                <p>
                  {report.dataset && (
                    <>
                      数据组：{report.dataset.rowName} · 数据集 v
                      {report.dataset.version} ·{" "}
                    </>
                  )}
                  UI 登录：{report.auth.status} {report.auth.error} · 清理：
                  {report.cleanupStatus}
                </p>
                {(
                  report.semanticSteps ??
                  cases.find(
                    (c) =>
                      c.caseId === report.caseId &&
                      c.version === report.caseVersion,
                  )?.steps ??
                  []
                ).map((s) => (
                  <article key={s.id}>
                    <h3>{s.title}</h3>
                    <p>预期：{s.expected}</p>
                    {report.steps
                      .filter((r) => r.semanticStepRef === s.id)
                      .map((r) => (
                        <details key={r.stepId}>
                          <summary>
                            {r.status} · {r.stepId} · {r.endedAt - r.startedAt}{" "}
                            ms
                          </summary>
                          <pre>{JSON.stringify(r, null, 2)}</pre>
                        </details>
                      ))}
                  </article>
                ))}
                <details>
                  <summary>
                    运行级资源台账 · 残留 {report.residualResources.length}
                  </summary>
                  <pre>{JSON.stringify(report.resources, null, 2)}</pre>
                </details>
                <details>
                  <summary>完整脱敏报告</summary>
                  <pre>{JSON.stringify(report, null, 2)}</pre>
                </details>
              </section>
            )}
          </>
        )}
        {tab === "配置" && (
          <>
            <section>
              <h2>工作区</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  void task(async () => {
                    await api("/workspaces", { name: d.get("name") });
                  });
                }}
              >
                <input required name="name" placeholder="工作区名称" />
                <button disabled={busy}>创建工作区</button>
              </form>
              {workspaces.map((w) => (
                <div className="row" key={w.id}>
                  <span>{w.name}</span>
                  <button
                    className="secondary"
                    disabled={busy}
                    aria-label={`删除工作区 ${w.name}`}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `删除工作区“${w.name}”？用例、录制和报告将保留，可从“全部工作区”查看。`,
                        )
                      )
                        return;
                      void task(async () => {
                        await api(
                          `/workspaces/${encodeURIComponent(w.id)}`,
                          undefined,
                          "DELETE",
                        );
                        setNotice("工作区已删除，用例、录制和报告已保留。");
                      });
                    }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </section>
            <section>
              <h2>环境与 UI 认证协议</h2>
              <p>
                显式配置允许访问的站点、写操作权限与声明式登录动作。密码使用
                secretRef 引用服务端环境变量；不要在此输入密钥值。
              </p>
              <p>
                内部测试站点使用自签名证书时，可在该环境 JSON 中设置
                ignoreHTTPSErrors 为 true，仅跳过这个环境的录制与回放证书校验。
                默认 false；请只对你信任的测试环境开启。
              </p>
              <div className="toolbar">
                <button
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    setNotice("");
                    setCreatingEnvironment(true);
                  }}
                >
                  新增环境
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    void task(async () => {
                      setConfigDirty(false);
                      setConfigKind("environments");
                      setConfigId(environmentRef);
                    })
                  }
                >
                  编辑环境
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    void task(async () => {
                      setConfigDirty(false);
                      setConfigKind("auth-profiles");
                      setConfigId(authProfiles[0]?.id ?? "");
                    })
                  }
                >
                  编辑 UI AuthProfile
                </button>
              </div>
              {creatingEnvironment && (
                <EnvironmentForm
                  onCancel={() => setCreatingEnvironment(false)}
                  onCreate={async (environment) => {
                    const saved = await api<Environment>("/environments", {
                      ...environment,
                      createOnly: true,
                    });
                    await refresh();
                    setConfigKind("environments");
                    setConfigDirty(false);
                    setConfigId(saved.id);
                    setEnvironmentRef(saved.id);
                    setCreatingEnvironment(false);
                    setNotice(
                      `环境“${saved.id}”已创建并保存，可在录制页选择。`,
                    );
                  }}
                />
              )}
              <label>
                已保存配置
                <select
                  aria-label="已保存配置"
                  value={configId}
                  onChange={(e) => {
                    setConfigDirty(false);
                    setConfigId(e.target.value);
                  }}
                >
                  {(configKind === "environments"
                    ? environments
                    : authProfiles
                  ).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                当前配置类型：{configKind}。修改 id
                可新建配置。保存后写入本地数据库，刷新或重启后仍可选择。
              </p>
              <textarea
                className="json"
                aria-label="环境配置 JSON"
                value={configText}
                onChange={(e) => {
                  setConfigText(e.target.value);
                  setConfigDirty(true);
                }}
              />
              <button
                disabled={busy}
                onClick={() =>
                  void task(async () => {
                    const saved = await api<{ id: string }>(
                      "/" + configKind,
                      JSON.parse(configText),
                    );
                    await refresh();
                    setConfigDirty(false);
                    setConfigId(saved.id);
                    if (configKind === "environments")
                      setEnvironmentRef(saved.id);
                    setNotice("配置已保存；后续验证和回放使用最新配置。");
                  })
                }
              >
                保存配置
              </button>
            </section>
          </>
        )}
        <footer>TracePilot · 录制是证据，审核后的计划才是执行契约。</footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
