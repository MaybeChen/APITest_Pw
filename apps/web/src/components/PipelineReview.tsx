import { useEffect, useState } from "react";
import type { Generation } from "../../../../packages/planner/src/workflow";
import type {
  AuthProfile,
  TestCase,
} from "../../../../packages/contracts/src/index";
export function PipelineReview({
  job,
  onSubmitted,
}: {
  job: Generation;
  onSubmitted: () => void;
}) {
  const [scenario, setScenario] = useState(
    job.scenario ?? job.input.recording.scenario,
  );
  const [selected, setSelected] = useState(job.selectedApiIds ?? []);
  const [testCase, setTestCase] = useState<TestCase | undefined>(
    job.testCase ? structuredClone(job.testCase) : undefined,
  );
  const [acknowledge, setAcknowledge] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [profiles, setProfiles] = useState<AuthProfile[]>([]);
  const [authProfileRef, setAuthProfileRef] = useState(
    job.authProfileRef ?? "",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    if (job.state === "WAITING_CASE_REVIEW")
      void fetch("/api/auth-profiles")
        .then(async (r) => {
          if (!r.ok) throw new Error(await r.text());
          const data = (await r.json()) as AuthProfile[];
          if (!cancelled) setProfiles(data);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });
    return () => {
      cancelled = true;
    };
  }, [job.state]);
  const submit = async (action: string, value: unknown) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/generations/${job.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: job.revision, ...(value as object) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "提交失败");
      onSubmitted();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <div className="pipeline-review">
      {job.state === "WAITING_INTERFACE_REVIEW" && (
        <>
          <h3>确认场景接口</h3>
          <p>
            已按批次整理接口，并按场景推荐勾选。下方保留全部接口，可手动选择或取消；确认前不会生成测试用例。
          </p>
          <label>
            用户场景
            <textarea
              value={scenario}
              maxLength={6000}
              onChange={(e) => setScenario(e.target.value)}
            />
          </label>
          {scenario !== job.scenario && (
            <p role="status">
              场景已修改，当前勾选仍来自上次推荐；可重新推荐，或手动核对后确认。
            </p>
          )}
          <button
            className="secondary"
            disabled={busy || !scenario.trim()}
            onClick={() => void submit("scenario", { scenario })}
          >
            按新场景重新推荐
          </button>
          <p>
            已选择 {selected.length} / {job.catalog?.length ?? 0} 个接口
          </p>
          <div className="interface-catalog">
            {job.catalog?.map((item) => {
              const recommendation = job.recommendations?.selected.find(
                (s) => s.apiId === item.apiId,
              );
              return (
                <article className="catalog-item" key={item.apiId}>
                  <label className="interface-choice">
                    <input
                      type="checkbox"
                      checked={selected.includes(item.apiId)}
                      disabled={busy}
                      aria-label={`选择接口 ${item.apiId}`}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, item.apiId]
                            : selected.filter((id) => id !== item.apiId),
                        )
                      }
                    />
                    <strong>{item.name}</strong>
                    <code>{item.apiId}</code>
                  </label>
                  <p>{item.description}</p>
                  <small>
                    {recommendation
                      ? `${recommendation.role === "DEPENDENCY" ? "依赖接口" : "场景接口"}：${recommendation.reason}`
                      : "模型未推荐，可手动选择"}
                  </small>
                  {!!item.uncertainties.length && (
                    <p>待确认：{item.uncertainties.join("；")}</p>
                  )}
                  <details>
                    <summary>
                      接口采集事实：自定义 Header、入参、出参及样例
                    </summary>
                    <pre>
                      {JSON.stringify(
                        {
                          apiId: item.apiId,
                          customHeaders: item.customHeaders,
                          parameters: {
                            path: item.asset.parameters,
                            query: item.querySchema,
                            body: item.asset.requestSchema,
                          },
                          requestSchema: item.asset.requestSchema,
                          responseSchema: item.asset.responseSchema,
                          samples: item.samples,
                          sources: item.asset.sources,
                        },
                        null,
                        2,
                      )}
                    </pre>
                    <small>
                      以上为录制样例，不代表已确认的必填规则或完整契约。
                    </small>
                  </details>
                </article>
              );
            })}
          </div>
          {!!job.recommendations?.uncertainties.length && (
            <p>筛选不确定项：{job.recommendations.uncertainties.join("；")}</p>
          )}
          {!!job.dependencyWarnings?.length && (
            <p role="status" className="message">
              {job.dependencyWarnings.join("\n")}
            </p>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              checked={acknowledge}
              onChange={(e) => setAcknowledge(e.target.checked)}
            />
            已核对候选依赖；如有未选来源接口，确认本场景不需要它们
          </label>
          <button
            disabled={busy || !selected.length || !scenario.trim()}
            onClick={() =>
              void submit("interfaces", {
                selectedApiIds: selected,
                scenario,
                acknowledgeDependencies: acknowledge,
                confirmed: true,
              })
            }
          >
            确认接口，生成语义用例
          </button>
        </>
      )}
      {job.state === "WAITING_CASE_REVIEW" && testCase && (
        <>
          <h3>确认语义测试用例</h3>
          <p>
            请检查前置条件、输入要求、操作步骤及预期。确认后才会生成接口调用计划。
          </p>
          <label>
            用例名称
            <input
              value={testCase.name}
              onChange={(e) =>
                setTestCase({ ...testCase, name: e.target.value })
              }
            />
          </label>
          <label>
            业务目标
            <textarea
              value={testCase.objective}
              onChange={(e) =>
                setTestCase({ ...testCase, objective: e.target.value })
              }
            />
          </label>
          <label>
            前置条件（每行一条）
            <textarea
              value={testCase.preconditions.join("\n")}
              onChange={(e) =>
                setTestCase({
                  ...testCase,
                  preconditions: e.target.value.split("\n").filter(Boolean),
                })
              }
            />
          </label>
          <label>
            输入要求（每行一条）
            <textarea
              value={(testCase.inputRequirements ?? []).join("\n")}
              onChange={(e) =>
                setTestCase({
                  ...testCase,
                  inputRequirements: e.target.value.split("\n").filter(Boolean),
                })
              }
            />
          </label>
          {testCase.steps.map((step, i) => {
            const update = (patch: Partial<typeof step>) =>
              setTestCase({
                ...testCase,
                steps: testCase.steps.map((item, index) =>
                  index === i ? { ...item, ...patch } : item,
                ),
              });
            return (
              <article className="catalog-item" key={step.id}>
                <h4>
                  步骤 {i + 1} · {step.id}
                </h4>
                <label>
                  操作步骤
                  <input
                    value={step.title}
                    onChange={(e) => update({ title: e.target.value })}
                  />
                </label>
                <label>
                  步骤类型
                  <select
                    value={step.executionKind ?? "API"}
                    onChange={(e) =>
                      update({
                        executionKind: e.target
                          .value as typeof step.executionKind,
                      })
                    }
                  >
                    <option value="API">API 业务步骤</option>
                    <option value="UI_PRECONDITION">页面前置条件</option>
                    <option value="MANUAL_PRECONDITION">人工前置条件</option>
                  </select>
                </label>
                <label>
                  步骤输入
                  <textarea
                    value={(step.inputs ?? []).join("\n")}
                    onChange={(e) =>
                      update({
                        inputs: e.target.value.split("\n").filter(Boolean),
                      })
                    }
                  />
                </label>
                <label>
                  预期结果
                  <textarea
                    value={step.expected}
                    onChange={(e) => update({ expected: e.target.value })}
                  />
                </label>
                <small>
                  依赖：{step.dependsOn.join(" → ") || "无"}
                  ；页面及人工前置条件不会自动变成接口节点。
                </small>
              </article>
            );
          })}
          <label>
            整体预期
            <textarea
              value={testCase.expected}
              onChange={(e) =>
                setTestCase({ ...testCase, expected: e.target.value })
              }
            />
          </label>
          <label>
            UI 认证协议
            <select
              value={authProfileRef}
              onChange={(e) => setAuthProfileRef(e.target.value)}
            >
              <option value="">请选择已配置的认证协议</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.id}
                </option>
              ))}
            </select>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我已确认前置条件、输入步骤及预期结果
          </label>
          <button
            disabled={busy || !confirmed || !authProfileRef}
            onClick={() =>
              void submit("case", { testCase, authProfileRef, confirmed: true })
            }
          >
            确认用例，生成调用计划
          </button>
        </>
      )}
      {busy && <p role="status">已提交，正在推进下一阶段…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

export function ScenarioFork({
  job,
  onFork,
}: {
  job: Generation;
  onFork: (id: string) => Promise<void>;
}) {
  const [scenario, setScenario] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <details>
      <summary>复用接口目录生成其他场景</summary>
      <p>
        保留当前任务，新场景复用已整理的接口，从场景筛选开始，不会重新调用接口整理模型。
      </p>
      <label>
        新场景
        <textarea
          maxLength={6000}
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
        />
      </label>
      <button
        disabled={busy || !scenario.trim()}
        onClick={() => {
          void (async () => {
            setBusy(true);
            setError("");
            try {
              const response = await fetch(
                `/api/generations/${job.id}/fork-scenario`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ revision: job.revision, scenario }),
                },
              );
              const data = await response.json();
              if (!response.ok) throw new Error(data.error ?? "创建失败");
              await onFork(data.id);
            } catch (e) {
              setError(String(e));
              setBusy(false);
            }
          })();
        }}
      >
        复用目录，开始新场景
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </details>
  );
}
