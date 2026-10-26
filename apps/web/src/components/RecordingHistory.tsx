import type { Recording } from "../../../../packages/contracts/src/index";
import type { Generation } from "../../../../packages/planner/src/workflow";
export function RecordingHistory({
  recordings,
  generations,
  analyzedIds,
  approvedCaseIds,
  busy,
  onOpen,
}: {
  recordings: Recording[];
  generations: Generation[];
  analyzedIds: Set<string>;
  approvedCaseIds: Set<string>;
  busy: boolean;
  onOpen: (recording: Recording) => void;
}) {
  return (
    <section>
      <h2>历史录制</h2>
      <p>一次录制对应一条记录，分析、生成任务和用例产物都保留在这条记录下。</p>
      {!recordings.length ? (
        <p className="empty">当前工作区暂无录制，点击“新建录制流程”开始。</p>
      ) : (
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>录制 / 场景</th>
                <th>阶段</th>
                <th>请求 / 生成次数</th>
                <th>开始时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {[...recordings]
                .sort((a, b) => b.startedAt - a.startedAt)
                .map((recording) => {
                  const jobs = generations
                    .filter((j) => j.input.recording.id === recording.id)
                    .sort((a, b) => b.createdAt - a.createdAt);
                  const job = jobs[0];
                  const state =
                    recording.state === "RECORDING"
                      ? "录制中"
                      : job?.testCase &&
                          approvedCaseIds.has(job.testCase.caseId)
                        ? "已批准"
                        : job
                          ? {
                              RUNNING: "生成中",
                              FAILED: "生成失败",
                              NEEDS_REVIEW: "待审核",
                            }[job.state]
                          : analyzedIds.has(recording.id)
                            ? "已分析，待生成"
                            : "待分析";
                  return (
                    <tr key={recording.id}>
                      <td>
                        <strong>{recording.caseName}</strong>
                        <small>{recording.scenario}</small>
                        <small>{recording.target}</small>
                      </td>
                      <td>
                        <span
                          className={`badge ${job?.state === "FAILED" ? "failed" : ""}`}
                        >
                          {state}
                        </span>
                      </td>
                      <td>
                        {recording.requests.length} 个请求 · {jobs.length}{" "}
                        次生成
                      </td>
                      <td>{new Date(recording.startedAt).toLocaleString()}</td>
                      <td>
                        <button
                          className="secondary"
                          disabled={busy}
                          aria-label={`打开流程 ${recording.caseName}`}
                          onClick={() => onOpen(recording)}
                        >
                          查看 / 继续
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
