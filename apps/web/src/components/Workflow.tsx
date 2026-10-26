import type { Plan } from "../../../../packages/contracts/src/index";
export function Workflow({ plan }: { plan: Plan }) {
  const levels = new Map<string, number>();
  const pending = [...plan.steps];
  for (let n = 0; n < plan.steps.length; n++)
    for (const step of [...pending])
      if (step.dependsOn.every((id) => levels.has(id))) {
        levels.set(
          step.id,
          Math.max(-1, ...step.dependsOn.map((id) => levels.get(id)!)) + 1,
        );
        pending.splice(pending.indexOf(step), 1);
      }
  const positions = new Map<string, { x: number; y: number }>();
  const rows = new Map<number, number>();
  for (const step of plan.steps) {
    const level = levels.get(step.id) ?? 0;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    positions.set(step.id, { x: level * 230 + 10, y: row * 85 + 15 });
  }
  return (
    <section>
      <h3>接口依赖工作流</h3>
      <p>
        最大并发 {plan.execution?.maxConcurrency ?? 1}
        ；只有明确标记安全的只读接口可并行。Cleanup 按 ALWAYS 策略串行执行。
      </p>
      <div style={{ overflowX: "auto" }}>
        <svg
          role="img"
          aria-label="接口依赖工作流"
          width={(Math.max(0, ...levels.values()) + 1) * 230}
          height={Math.max(1, ...rows.values()) * 85 + 15}
        >
          {plan.steps.flatMap((step) =>
            step.dependsOn.map((id) => {
              const from = positions.get(id),
                to = positions.get(step.id);
              return from && to ? (
                <path
                  key={`${id}-${step.id}`}
                  d={`M${from.x + 200},${from.y + 25} L${to.x},${to.y + 25}`}
                  stroke="#64748b"
                  fill="none"
                />
              ) : null;
            }),
          )}
          {plan.steps.map((step) => {
            const p = positions.get(step.id)!;
            return (
              <g key={step.id} transform={`translate(${p.x},${p.y})`}>
                <rect
                  width="200"
                  height="60"
                  rx="7"
                  fill={step.phase === "CLEANUP" ? "#fef3c7" : "#dbeafe"}
                />
                <text x="8" y="22" fill="#172554">
                  {step.id.slice(0, 24)}
                </text>
                <text x="8" y="43" fill="#172554">
                  {step.phase} · {step.parallelSafe ? "可并行" : "串行"}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <h3>参数传递</h3>
      <table>
        <thead>
          <tr>
            <th>节点</th>
            <th>来源 / 提取路径</th>
            <th>绑定目标</th>
          </tr>
        </thead>
        <tbody>
          {plan.steps.flatMap((step) =>
            [
              ...Object.entries(step.path).map(([key, value]) => ({
                key: `PATH ${key}`,
                value,
              })),
              ...Object.entries(step.query).map(([key, value]) => ({
                key: `QUERY ${key}`,
                value,
              })),
              ...Object.entries(step.headers).map(([key, value]) => ({
                key: `HEADER ${key}`,
                value,
              })),
              ...(step.body ? [{ key: "BODY $", value: step.body }] : []),
              ...Object.entries(step.bodyBindings ?? {}).map(
                ([key, value]) => ({ key: `BODY ${key}`, value }),
              ),
            ]
              .filter(({ value }) =>
                ["RESPONSE_VARIABLE", "TEST_DATA"].includes(value.source),
              )
              .map(({ key, value }) => (
                <tr key={`${step.id}-${key}`}>
                  <td>{step.id}</td>
                  <td>
                    <code>{JSON.stringify(value)}</code>
                  </td>
                  <td>{key}</td>
                </tr>
              )),
          )}
        </tbody>
      </table>
      <p>
        依赖、并发标记、资源锁、提取路径和类型可在 JSON
        编辑中修改，审批时会重新校验。
      </p>
    </section>
  );
}
