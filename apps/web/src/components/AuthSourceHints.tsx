import type {
  AuthProfile,
  AuthSourceHint,
} from "../../../../packages/contracts/src/index";
export function applyAuthHints(
  profile: AuthProfile,
  hints: AuthSourceHint[],
): AuthProfile {
  const next = structuredClone(profile);
  if (
    !next.headers ||
    typeof next.headers !== "object" ||
    Array.isArray(next.headers) ||
    !next.tokenSources ||
    typeof next.tokenSources !== "object" ||
    Array.isArray(next.tokenSources)
  )
    throw new Error("Token 来源和 Header 绑定必须是 JSON 对象");
  for (const hint of hints) {
    const old = Object.keys(next.headers).find(
      (key) => key.toLowerCase() === hint.header.toLowerCase(),
    );
    const binding = old ? next.headers[old] : undefined;
    const name =
      binding?.source === "AUTH_CONTEXT"
        ? binding.name
        : `recorded_${hint.header.replace(/[^A-Za-z0-9_]/g, "_")}`;
    if (next.tokenSources[name] && binding?.source !== "AUTH_CONTEXT")
      throw new Error(`变量 ${name} 已存在，请先核对配置，避免覆盖其他来源`);
    if (old) delete next.headers[old];
    next.headers[hint.header] = { source: "AUTH_CONTEXT", name };
    next.tokenSources[name] = {
      source: hint.source,
      storageKey: hint.storageKey,
      prefix: hint.prefix,
      ...(hint.origin ? { origin: hint.origin } : {}),
      ...(hint.url ? { url: hint.url } : {}),
      ...(hint.method ? { method: hint.method } : {}),
    };
  }
  return next;
}
export function AuthSourceHints({
  hints,
  disabled,
  onApply,
}: {
  hints: AuthSourceHint[];
  disabled: boolean;
  onApply: (hints: AuthSourceHint[]) => void;
}) {
  const labels = {
    cookie: "Cookie",
    localStorage: "localStorage",
    sessionStorage: "sessionStorage",
    response: "前置接口响应",
    responseHeader: "前置接口响应 Header",
  };
  const unique = hints.filter(
    (hint) =>
      hints.filter((other) => other.header === hint.header).length === 1,
  );
  return (
    <section>
      <h4>自动识别的认证来源</h4>
      <p>
        通过录制时请求 Header
        与浏览器存储或前置接口响应值精确匹配得到，仅保存来源名称，不保存 Token
        值；多个来源匹配时需选择一个。
      </p>
      {hints.length ? (
        <>
          <table>
            <thead>
              <tr>
                <th>请求 Header</th>
                <th>浏览器来源</th>
                <th>来源字段 / 存储项</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {hints.map((hint) => (
                <tr
                  key={JSON.stringify([
                    hint.header,
                    hint.source,
                    hint.storageKey,
                    hint.origin,
                    hint.url,
                  ])}
                >
                  <td>{hint.header}</td>
                  <td>{labels[hint.source]}</td>
                  <td>
                    {hint.storageKey}
                    {(hint.source === "response" ||
                      hint.source === "responseHeader") && (
                      <small>
                        {hint.method ?? "GET"} {hint.url}
                      </small>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onApply([hint])}
                    >
                      使用此来源 {hint.header}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {unique.length > 0 && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onApply(unique)}
            >
              应用唯一识别的来源
            </button>
          )}
        </>
      ) : (
        <p>
          这份录制尚未识别到来源。请重新录制真实的登录和页面准备操作，并触发需要认证的接口；无法匹配时会保持未知，不会猜测来源。
        </p>
      )}
    </section>
  );
}
