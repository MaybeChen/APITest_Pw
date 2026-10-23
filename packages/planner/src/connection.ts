export class ModelConnectionError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ModelConnectionError";
  }
}
export function modelConnectionError(
  error: unknown,
  endpoint: string,
): ModelConnectionError {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  function visit(value: unknown, depth = 0) {
    if (
      !value ||
      typeof value !== "object" ||
      seen.has(value) ||
      depth > 5 ||
      seen.size >= 20
    )
      return;
    seen.add(value);
    const e = value as {
      code?: unknown;
      name?: unknown;
      cause?: unknown;
      errors?: unknown[];
    };
    if (typeof e.code === "string" && /^[A-Z0-9_]+$/.test(e.code))
      codes.push(e.code);
    if (e.name === "TimeoutError") codes.push("TIMEOUT");
    visit(e.cause, depth + 1);
    if (Array.isArray(e.errors))
      e.errors.forEach((item) => visit(item, depth + 1));
  }
  visit(error);
  const code = codes[0] ?? "UNKNOWN_NETWORK_ERROR";
  let hint =
    "请检查运行 pnpm dev 的电脑是否能访问模型地址，以及 VPN、DNS 和代理设置。";
  let retryable = false;
  if (codes.some((c) => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ISSUER/.test(c)))
    hint =
      "模型 HTTPS 证书不受 Node.js 信任或证书有误。可在 config/ai.json 配置 caFile 指向内部 CA 的 PEM 证书；证书过期或域名不匹配需要修复服务证书。业务站点的 ignoreHTTPSErrors 不影响模型连接。";
  else if (codes.includes("ENOTFOUND") || codes.includes("EAI_AGAIN"))
    hint = "模型域名解析失败，请在后端电脑检查 DNS 和内网 VPN。";
  else if (codes.includes("ECONNREFUSED"))
    hint = "模型服务或代理拒绝连接，请确认地址、端口及服务状态。";
  else if (
    codes.some((c) =>
      /TIMEOUT|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(
        c,
      ),
    )
  ) {
    hint =
      "连接或模型响应超时，请检查内网连通性、代理，必要时调整 config/ai.json 的 timeoutMs。";
    retryable = true;
  } else if (codes.includes("ECONNRESET") || codes.includes("UND_ERR_SOCKET")) {
    hint = "连接被服务或代理中断，请检查网关和代理设置。";
    retryable = true;
  }
  const url = new URL(endpoint);
  return new ModelConnectionError(
    code,
    retryable,
    `模型连接失败 [${codes.length ? [...new Set(codes)].join(", ") : code}] ${url.origin}${url.pathname}。${hint}`,
  );
}
export interface ModelRequestOptions {
  method: "POST";
  redirect: "manual";
  signal: AbortSignal;
  headers: Record<string, string>;
  body: string;
}
export interface ModelHTTPResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type ModelRequester = (
  url: string,
  options: ModelRequestOptions,
) => Promise<ModelHTTPResponse>;
