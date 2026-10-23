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
import { EnvironmentForm } from "./components/EnvironmentForm";
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
  const [tab, setTab] = useState("工作区"),
    [workspaceId, setWorkspaceId] = useState(""),
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
  const refresh = async () => {
    const [c, p, r, re, w, en, dr, profiles] = await Promise.all([
      api<TestCase[]>("/cases"),
      api<Plan[]>("/plans"),
      api<Recording[]>("/recordings"),
      api<Report[]>("/reports"),
      api<{ id: string; name: string }[]>("/workspaces"),
      api<Environment[]>("/environments"),
      api<Bundle[]>("/drafts"),
      api<AuthProfile[]>("/auth-profiles"),
    ]);
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
          {[
            "工作区",
            "浏览器录制",
            "分析与筛选",
            "用例编辑",
            "运行报告",
            "环境配置",
          ].map((t, i) => (
            <button
              key={t}
              className={t === tab ? "active" : ""}
              onClick={() => setTab(t)}
            >
              <span>0{i + 1}</span>
              {t}
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
            <p className="eyebrow">WORKSPACE / {tab}</p>
            <h1>{tab}</h1>
          </div>
          <span className="badge">AI 辅助 · 人工审核 · 确定性回放</span>
        </header>
        <p className="subtitle">
          从浏览器中的业务流程，到可追溯的 API 回归测试。
        </p>
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
        {tab === "工作区" && (
          <>
            <div className="stats">
              {[
                ["已批准版本", cases.length],
                ["录制记录", recordings.length],
                ["历史运行", reports.length],
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
              <button disabled={busy} onClick={() => setTab("浏览器录制")}>
                ＋ 创建录制
              </button>
              <button className="secondary" disabled={busy} onClick={loadDemo}>
                载入订单演示模板
              </button>
            </section>
            <section>
              <h2>工作区</h2>
              <select
                aria-label="当前工作区"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                <option value="">全部工作区</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
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
              <h2>草稿历史</h2>
              {drafts
                .filter(
                  (b, i, a) =>
                    a.findIndex(
                      (x) => x.testCase.caseId === b.testCase.caseId,
                    ) === i,
                )
                .filter(
                  (b) => !workspaceId || b.testCase.workspaceId === workspaceId,
                )
                .map((b) => (
                  <button
                    className="secondary"
                    key={b.testCase.caseId}
                    onClick={() => {
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
                  .filter((c) => !workspaceId || c.workspaceId === workspaceId)
                  .map((c) => (
                    <div className="row" key={`${c.caseId}:${c.version}`}>
                      <div>
                        <b>{c.name}</b>
                        <p>
                          Case v{c.version} · {c.status} · 最近结果：
                          {reports.find((r) => r.caseId === c.caseId)?.status ??
                            "未运行"}
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
                                disabled={busy}
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
            <section>
              <h2>录制会话</h2>
              {recordings.map((r) => (
                <button
                  className="secondary"
                  key={r.id}
                  onClick={() => {
                    setRecording(r);
                    setTab("浏览器录制");
                  }}
                >
                  {r.caseName} · {r.state}
                </button>
              ))}
            </section>
          </>
        )}
        {tab === "浏览器录制" && (
          <>
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
                  <input required name="caseName" placeholder="删除订单成功" />
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
                <button disabled={busy || recording?.state === "RECORDING"}>
                  开始录制
                </button>
              </form>
            </section>
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
                          void task(async () =>
                            setRecording(
                              await api<Recording>(
                                "/recordings/" + recording.id + "/stop",
                                {},
                              ),
                            ),
                          )
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
                    <pre>{JSON.stringify(r, null, 2)}</pre>
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
                  规则分类与时间关联均为候选证据。未知请求保留在列表中供人工检查。
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
                      <span className="badge">{r.category}</span>
                    </summary>
                    <p>
                      {r.classification?.reason} · 置信度{" "}
                      {r.classification?.confidence}
                    </p>
                    <pre>
                      {JSON.stringify(
                        {
                          headers: r.headers,
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
                  disabled={busy}
                  onClick={() =>
                    void task(async () => {
                      edit(
                        await api<Bundle>("/generate", {
                          ...analysis,
                          environmentRef,
                        }),
                      );
                      setTab("用例编辑");
                    })
                  }
                >
                  生成双产物草稿
                </button>
              </>
            )}
          </section>
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
                              JSON.stringify(bundle.plan.steps)
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
                <div className="toolbar">
                  <button
                    className="secondary"
                    disabled={busy || bundle.plan.status === "APPROVED"}
                    onClick={() =>
                      void task(async () => {
                        edit(await api<Bundle>("/drafts", bundle));
                        setNotice("草稿已保存，可从工作区重新打开。");
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
                      disabled={busy}
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
              {!reports.length && <p className="empty">尚无运行报告。</p>}
              {reports.map((r) => (
                <button
                  className="secondary"
                  key={r.id}
                  onClick={() => {
                    setReport(r);
                    void task(async () => {
                      const c = cases.find(
                        (c) =>
                          c.caseId === r.caseId && c.version === r.caseVersion,
                      );
                      const p = plans.find(
                        (p) =>
                          p.planId === r.planId && p.version === r.planVersion,
                      );
                      if (c && p)
                        edit({
                          testCase: c,
                          plan: p,
                          assets: await api("/assets"),
                        });
                    });
                  }}
                >
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
                  UI 登录：{report.auth.status} {report.auth.error} · 清理：
                  {report.cleanupStatus}
                </p>
                {(report.semanticSteps ?? bundle?.testCase.steps ?? []).map(
                  (s) => (
                    <article key={s.id}>
                      <h3>{s.title}</h3>
                      <p>预期：{s.expected}</p>
                      {report.steps
                        .filter((r) => r.semanticStepRef === s.id)
                        .map((r) => (
                          <details key={r.stepId}>
                            <summary>
                              {r.status} · {r.stepId} ·{" "}
                              {r.endedAt - r.startedAt} ms
                            </summary>
                            <pre>{JSON.stringify(r, null, 2)}</pre>
                          </details>
                        ))}
                    </article>
                  ),
                )}
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
        {tab === "环境配置" && (
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
                  setNotice(`环境“${saved.id}”已创建并保存，可在录制页选择。`);
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
        )}
        <footer>TracePilot · 录制是证据，审核后的计划才是执行契约。</footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
