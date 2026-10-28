import { useEffect, useState } from "react";
import type {
  Dataset,
  Plan,
  Binding,
  Report,
} from "../../../../packages/contracts/src/index";
type Kind = NonNullable<Plan["parameters"]>[string];
function kind(value: unknown): Kind {
  return value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : (typeof value as Kind);
}
export function Datasets({
  plan,
  onChange,
  onReports,
  busy,
  candidate,
}: {
  candidate?: Dataset;
  plan: Plan;
  onChange: (plan: Plan) => void;
  onReports: (reports: Report[]) => void;
  busy: boolean;
}) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selected, setSelected] = useState("");
  const [rows, setRows] = useState(
    candidate
      ? JSON.stringify(candidate.rows, null, 2)
      : '[{"id":"row-1","name":"数据 1","values":{}}]',
  );
  const [name, setName] = useState(candidate?.name ?? "测试数据");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [baseline, setBaseline] = useState(candidate);
  const originLabels = {
    RECORDING: "录制值",
    USER: "用户指定",
    MODEL_SUGGESTED: "模型建议",
    MISSING: "缺少值",
  };
  let editedRows: Dataset["rows"] = [];
  try {
    const parsed: unknown = JSON.parse(rows);
    if (Array.isArray(parsed))
      editedRows = parsed.filter(
        (row) =>
          row &&
          typeof row === "object" &&
          row.values &&
          typeof row.values === "object" &&
          !Array.isArray(row.values),
      );
  } catch {
    /* JSON editor may be incomplete. */
  }
  const sources = Object.fromEntries(
    Object.keys(plan.parameters ?? {}).map((key) => {
      const unchanged =
        editedRows.length > 0 &&
        editedRows.every((row) => {
          const original =
            baseline?.rows.find((item) => item.id === row.id) ??
            baseline?.rows[0];
          return (
            original &&
            Object.hasOwn(row.values ?? {}, key) ===
              Object.hasOwn(original.values, key) &&
            JSON.stringify(row.values[key]) ===
              JSON.stringify(original.values[key])
          );
        });
      const source = unchanged
        ? (baseline?.review?.sources[key] ??
          plan.dataRequirements?.[key]?.source ??
          "USER")
        : "USER";
      return [key, source];
    }),
  ) as NonNullable<Dataset["review"]>["sources"];

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/datasets")
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        const data = (await r.json()) as Dataset[];
        if (!cancelled) setDatasets(data);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [plan.planId, plan.version]);
  const available = datasets.filter(
    (d) => d.planId === plan.planId && d.planVersion === plan.version,
  );
  const extract = () => {
    const next = structuredClone(plan);
    next.parameters ??= {};
    const values: Record<string, unknown> = {};
    const bind = (binding: Binding, key: string): Binding => {
      if (binding.source !== "STATIC" || binding.value === undefined)
        return binding;
      let unique = key;
      while (Object.hasOwn(next.parameters!, unique)) unique += "_";
      next.parameters![unique] = kind(binding.value);
      values[unique] = binding.value;
      return { source: "TEST_DATA", name: unique };
    };
    for (const step of next.steps) {
      for (const location of ["path", "query", "bodyBindings"] as const)
        for (const [key, value] of Object.entries(step[location] ?? {}))
          step[location]![key] = bind(value, `${step.id}_${location}_${key}`);
      if (step.body) step.body = bind(step.body, `${step.id}_body`);
      for (const [index, assertion] of step.assertions.entries())
        if (
          assertion.kind === "json" &&
          assertion.operator === "eq" &&
          !assertion.dataRef &&
          assertion.value !== undefined
        ) {
          const binding = bind(
            { source: "STATIC", value: assertion.value },
            `${step.id}_expected_${index}`,
          );
          if (binding.source === "TEST_DATA") {
            assertion.dataRef = binding.name;
            delete assertion.value;
          }
        }
    }
    if (!Object.keys(values).length) {
      setNotice("没有可提取的静态业务参数。");
      return;
    }
    next.status = "DRAFT";
    next.steps.forEach((s) =>
      s.assertions.forEach((a) => {
        a.confirmed = false;
      }),
    );
    setRows(
      JSON.stringify([{ id: "row-1", name: "录制数据", values }], null, 2),
    );
    setSelected("");
    setReviewConfirmed(false);
    onChange(next);
    setNotice(
      "已提取业务参数和 JSON 预期值。请审核流程，并在下面补齐已有参数、添加数据组；批准后保存数据集。",
    );
  };
  const act = async (execute: boolean) => {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      let dataset = available.find((d) => `${d.id}:${d.version}` === selected);
      if (!dataset) {
        const draft: Omit<Dataset, "id"> = {
          version: 1,
          name,
          planId: plan.planId,
          planVersion: plan.version,
          rows: JSON.parse(rows),
          review: { confirmed: reviewConfirmed, sources },
        };
        const response = await fetch("/api/datasets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(draft),
        });
        if (!response.ok) throw new Error(await response.text());
        dataset = (await response.json()) as Dataset;
        setDatasets((all) => [dataset!, ...all]);
        setSelected(`${dataset.id}:${dataset.version}`);
      }
      if (execute) {
        const response = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            planId: plan.planId,
            version: plan.version,
            dataset: { id: dataset.id, version: dataset.version },
          }),
        });
        if (!response.ok) throw new Error(await response.text());
        const data = (await response.json()) as { reports: Report[] };
        onReports(data.reports);
      } else setNotice(`已保存 ${dataset.rows.length} 组数据，可重复执行。`);
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };
  return (
    <section>
      <h3>测试数据集</h3>
      <p>
        调用流程定义参数和绑定，数据集独立保存。每组数据使用独立认证、变量和清理台账，并生成一份报告。
      </p>
      {plan.status !== "APPROVED" && (
        <button className="secondary" onClick={extract}>
          从流程提取测试数据
        </button>
      )}
      <p>
        流程参数：
        {Object.entries(plan.parameters ?? {})
          .map(([key, type]) => `${key} (${type})`)
          .join("，") ||
          "尚未定义；可提取静态业务参数，或在流程 JSON 中配置 parameters 和 TEST_DATA 绑定。"}
      </p>
      {Object.keys(plan.parameters ?? {}).length > 0 && (
        <>
          <h4>参数来源与数据审核</h4>
          <p>
            录制值可以复用；模型建议值需要核对场景，缺少值请补齐。修改下方数据组后会标记为用户指定，并需要重新确认。
          </p>
          <table>
            <thead>
              <tr>
                <th>参数</th>
                <th>类型</th>
                <th>来源</th>
                <th>接口字段</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(plan.parameters ?? {}).map(([key, type]) => {
                const requirement = plan.dataRequirements?.[key];
                return (
                  <tr key={key}>
                    <td>{key}</td>
                    <td>{type}</td>
                    <td>
                      {
                        originLabels[
                          (selected
                            ? available.find(
                                (d) => `${d.id}:${d.version}` === selected,
                              )?.review?.sources[key]
                            : sources[key]) ??
                            requirement?.source ??
                            "USER"
                        ]
                      }
                    </td>
                    <td>
                      {requirement
                        ? `${requirement.location} ${requirement.path}`
                        : "手工参数"}
                    </td>
                    <td>{requirement?.note ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      <label>
        选择数据集
        <select
          value={selected}
          disabled={working}
          onChange={(e) => {
            setSelected(e.target.value);
            setReviewConfirmed(false);
          }}
        >
          <option value="">新建数据集</option>
          {available.map((d) => (
            <option key={`${d.id}:${d.version}`} value={`${d.id}:${d.version}`}>
              {d.name} · v{d.version} · {d.rows.length} 组
            </option>
          ))}
        </select>
      </label>
      {!selected ? (
        <>
          <label>
            数据集名称
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            数据组（JSON 数组）
            <textarea
              className="dataset-editor"
              value={rows}
              onChange={(e) => {
                setRows(e.target.value);
                setReviewConfirmed(false);
              }}
              spellCheck={false}
            />
          </label>
        </>
      ) : (
        <>
          <pre>
            {JSON.stringify(
              available.find((d) => `${d.id}:${d.version}` === selected)?.rows,
              null,
              2,
            )}
          </pre>
          <button
            className="secondary"
            onClick={() => {
              const d = available.find(
                (d) => `${d.id}:${d.version}` === selected,
              )!;
              setBaseline(d);
              setRows(JSON.stringify(d.rows, null, 2));
              setName(`${d.name} 副本`);
              setSelected("");
              setReviewConfirmed(false);
            }}
          >
            复制并修改数据
          </button>
        </>
      )}
      {plan.dataPolicy === "REVIEW_REQUIRED" &&
        !selected &&
        Object.keys(plan.parameters ?? {}).length > 0 && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={reviewConfirmed}
              onChange={(e) => setReviewConfirmed(e.target.checked)}
            />
            我已核对所有数据组的参数来源、类型和值
          </label>
        )}
      {selected &&
        plan.dataPolicy === "REVIEW_REQUIRED" &&
        !available.find((d) => `${d.id}:${d.version}` === selected)?.review
          ?.confirmed && (
          <p>
            此数据集尚未审核。请“复制并修改数据”，核对并确认后保存为新数据集。
          </p>
        )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="toolbar">
        <button
          disabled={busy || working || plan.status !== "APPROVED"}
          onClick={() => void act(false)}
        >
          保存数据集
        </button>
        <button
          disabled={
            busy ||
            working ||
            plan.status !== "APPROVED" ||
            (plan.dataPolicy === "REVIEW_REQUIRED" &&
              Object.keys(plan.parameters ?? {}).length > 0 &&
              !(selected
                ? available.find((d) => `${d.id}:${d.version}` === selected)
                    ?.review?.confirmed
                : reviewConfirmed))
          }
          onClick={() => void act(true)}
        >
          {working ? "处理中…" : "执行全部数据组"}
        </button>
      </div>
      {plan.status !== "APPROVED" && (
        <small>审核并批准流程后，即可保存和执行数据集。</small>
      )}
    </section>
  );
}
