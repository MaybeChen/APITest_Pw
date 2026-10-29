import { useState } from "react";
import type { Environment } from "../../../../packages/contracts/src/index";

export function EnvironmentForm({
  onCreate,
  onCancel,
}: {
  onCreate: (environment: Environment) => Promise<void>;
  onCancel: () => void;
}) {
  const [id, setId] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [origins, setOrigins] = useState("");
  const [hostPatterns, setHostPatterns] = useState("");
  const [requestDomains, setRequestDomains] = useState("");
  const [requestPatterns, setRequestPatterns] = useState("");
  const [headerBlacklist, setHeaderBlacklist] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [allowHighRisk, setAllowHighRisk] = useState(false);
  const [ignoreHTTPSErrors, setIgnoreHTTPSErrors] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const originOf = (value: string) => {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("请填写不含用户名和密码的 HTTP/HTTPS 地址。");
    return url;
  };
  return (
    <form
      aria-label="新增环境表单"
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        void (async () => {
          setSaving(true);
          try {
            if (!id.trim()) throw new Error("请输入环境名称 / 标识。");
            const base = originOf(baseURL.trim());
            const additional = origins
              .split(/[\s,，]+/)
              .filter(Boolean)
              .map((value) => {
                const url = originOf(value);
                if (url.pathname !== "/" || url.search || url.hash)
                  throw new Error(
                    "允许访问的地址只能包含协议、主机和端口，不能包含路径。",
                  );
                return url.origin;
              });
            const recordingRequestDomains = [
              ...requestDomains.split(/[\s,，]+/).filter(Boolean),
              ...requestPatterns
                .split(/\r?\n/)
                .map((pattern) => pattern.trim())
                .filter(Boolean)
                .map((hostnameRegex) => ({ hostnameRegex })),
            ];
            await onCreate({
              id: id.trim(),
              baseURL: base.href,
              allowedOrigins: [
                ...new Set([base.origin, ...additional]),
                ...hostPatterns
                  .split(/\r?\n/)
                  .map((pattern) => pattern.trim())
                  .filter(Boolean)
                  .map((hostnameRegex) => ({
                    hostnameRegex,
                    protocol: "https:" as const,
                  })),
              ],
              ...(recordingRequestDomains.length
                ? { recordingRequestDomains }
                : {}),
              allowWrites,
              allowHighRisk,
              ignoreHTTPSErrors,
              headerBlacklist: headerBlacklist
                .split(/[\s,，]+/)
                .filter(Boolean),
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setSaving(false);
          }
        })();
      }}
    >
      <h3>新增环境</h3>
      <p>
        名称可以自定义，例如 dev、staging 或内部测试；保存后可在录制页选择。
      </p>
      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0 }}>
        <label>
          环境名称 / 标识
          <input
            required
            name="environmentId"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="例如 staging"
          />
        </label>
        <label>
          站点基础地址
          <input
            required
            type="url"
            name="baseURL"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://你的测试站点:端口"
          />
        </label>
        <label>
          额外允许访问的地址
          <textarea
            name="allowedOrigins"
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
            placeholder="可选；每行一个地址，用于登录跳转或独立 API 域名"
          />
        </label>
        <p>
          基础地址会自动加入允许列表。额外地址请包含协议和端口，不包含路径。
        </p>
        <label>
          允许访问的域名正则（HTTPS）
          <textarea
            name="hostnameRegex"
            value={hostPatterns}
            onChange={(e) => setHostPatterns(e.target.value)}
            placeholder={"可选；每行一个，例如 (^|\\.)huawei\\.com$"}
          />
        </label>
        <p>
          正则只匹配域名，不包含协议、路径或 / 分隔符；默认仅允许 HTTPS。使用
          (^|\.)huawei\.com$ 可包含根域名及其子域名。
        </p>
        <h3>API 执行设置</h3>
        <label>
          API 请求 Header 黑名单
          <textarea
            value={headerBlacklist}
            onChange={(event) => setHeaderBlacklist(event.target.value)}
            placeholder="可选；每行一个字段名，例如 x-gde-src-page；不区分大小写"
          />
        </label>
        <p>
          仅影响计划执行的 API 请求，不修改前置 UI
          或录制流量。留空不排除任何字段。
        </p>
        <h3>录制请求白名单</h3>
        <label>
          保留请求的域名白名单
          <textarea
            name="recordingRequestDomains"
            value={requestDomains}
            onChange={(e) => setRequestDomains(e.target.value)}
            placeholder="例如 api.example.com；每行一个域名，不含协议、端口或路径"
          />
        </label>
        <label>
          保留请求的域名正则
          <textarea
            name="recordingRequestPatterns"
            value={requestPatterns}
            onChange={(e) => setRequestPatterns(e.target.value)}
            placeholder={"例如 (^|\\.)huawei\\.com$；每行一条"}
          />
        </label>
        <p>
          两项都留空时保留所有 Fetch/XHR
          请求。填写后仅保存匹配域名的请求，不阻止其他请求发送，不影响页面加载和登录跳转。域名需同时符合上方的访问规则。
        </p>
        <label>
          <span>
            <input
              type="checkbox"
              checked={allowWrites}
              onChange={(e) => {
                setAllowWrites(e.target.checked);
                if (!e.target.checked) setAllowHighRisk(false);
              }}
            />
            允许创建、修改等写操作
          </span>
        </label>
        <label>
          <span>
            <input
              type="checkbox"
              checked={allowHighRisk}
              disabled={!allowWrites}
              onChange={(e) => setAllowHighRisk(e.target.checked)}
            />
            允许删除等高风险操作
          </span>
        </label>
        <label>
          <span>
            <input
              type="checkbox"
              checked={ignoreHTTPSErrors}
              onChange={(e) => setIgnoreHTTPSErrors(e.target.checked)}
            />
            忽略此环境的 HTTPS 证书错误
          </span>
        </label>
        <p>证书选项仅对你信任的内部测试环境开启，默认保持证书校验。</p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="toolbar">
          <button type="submit">{saving ? "正在保存…" : "保存新环境"}</button>
          <button type="button" className="secondary" onClick={onCancel}>
            取消新增
          </button>
        </div>
      </fieldset>
    </form>
  );
}
