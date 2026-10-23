import type { Recording } from "../../../../packages/contracts/src/index";
type RequestEvidence = Recording["requests"][number];
export function requestCategoryLabel(category: RequestEvidence["category"]) {
  return {
    UNKNOWN: "待确认接口",
    BUSINESS: "业务接口候选",
    AUTH_BOOTSTRAP: "登录 / 认证",
    TELEMETRY: "遥测 / 噪声候选",
    STATIC_RESOURCE: "静态资源",
  }[category];
}
function JsonEvidence({ value, empty }: { value: unknown; empty: string }) {
  return value === undefined ? (
    <p>{empty}</p>
  ) : (
    <pre>{JSON.stringify(value, null, 2)}</pre>
  );
}
export function RequestDetails({ request: r }: { request: RequestEvidence }) {
  const bodyNote = r.responseBodyCapture;
  const noBody =
    [204, 304].includes(r.status ?? 0) ||
    r.method === "HEAD" ||
    bodyNote?.state === "EMPTY";
  return (
    <div className="request-details">
      <p>
        以下为脱敏后的录制证据。分类来源：
        {r.classification?.source ?? "尚未分析"}；
        {requestCategoryLabel(r.category)}，不代表已经过大模型确认。
      </p>
      <dl>
        <dt>完整 URL</dt>
        <dd>{r.url}</dd>
        <dt>方法 / 资源类型</dt>
        <dd>
          {r.method} / {r.resourceType}
        </dd>
        <dt>响应状态</dt>
        <dd>{r.status ?? "尚未收到响应状态"}</dd>
        <dt>耗时</dt>
        <dd>{r.duration === undefined ? "未记录" : `${r.duration} ms`}</dd>
        <dt>请求时间</dt>
        <dd>{new Date(r.startedAt).toLocaleString()}</dd>
      </dl>
      <h3>请求 Query 参数</h3>
      <JsonEvidence value={r.query} empty="未记录 Query 参数" />
      <h3>请求 Headers</h3>
      <JsonEvidence value={r.headers} empty="未记录请求头" />
      <h3>请求 Body</h3>
      <JsonEvidence value={r.body} empty="此请求没有已保存的请求体" />
      <h3>响应 Headers</h3>
      <JsonEvidence value={r.responseHeaders} empty="未采集到响应头" />
      <h3>响应 Body</h3>
      <JsonEvidence
        value={r.response}
        empty={
          bodyNote?.reason ??
          (noBody
            ? "此响应没有正文"
            : "未保存响应正文（旧录制未记录采集原因，或采集时正文不可用）")
        }
      />
      {bodyNote && (
        <p>
          正文采集：
          {
            {
              CAPTURED: "已采集",
              EMPTY: "无正文",
              OMITTED: "未采集",
              FAILED: "采集失败",
            }[bodyNote.state]
          }
          {bodyNote.bytes === undefined ? "" : ` · ${bodyNote.bytes} bytes`}
        </p>
      )}
      {r.failure && <p className="error">网络失败：{r.failure}</p>}
      {r.redirectFrom && <p>重定向来源请求：{r.redirectFrom}</p>}
    </div>
  );
}
