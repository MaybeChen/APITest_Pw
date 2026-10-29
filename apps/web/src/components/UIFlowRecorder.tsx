import { AuthSourceHints, applyAuthHints } from "./AuthSourceHints";
import { useEffect, useState } from "react";
import type {
  Environment,
  AuthProfile,
  AuthSourceHint,
} from "../../../../packages/contracts/src/index";
type Snapshot = {
  id: string;
  environmentRef: string;
  target: string;
  state: "RECORDING" | "STOPPED";
  actions: AuthProfile["actions"];
  authHints?: AuthSourceHint[];
};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}
export function UIFlowRecorder({
  environments,
  onSaved,
  initialEnvironmentRef,
}: {
  environments: Environment[];
  initialEnvironmentRef?: string;
  onSaved: (profile: AuthProfile) => Promise<void>;
}) {
  const [environmentRef, setEnvironmentRef] = useState(
    environments.find((item) => item.id === initialEnvironmentRef)?.id ??
      environments[0]?.id ??
      "",
  );
  const [target, setTarget] = useState(
    environments.find((item) => item.id === initialEnvironmentRef)?.baseURL ??
      environments[0]?.baseURL ??
      "",
  );
  const [recording, setRecording] = useState<Snapshot>();
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [profileId, setProfileId] = useState("");
  const [readySelector, setReadySelector] = useState("");
  const [actions, setActions] = useState("[]");
  const [tokens, setTokens] = useState("{}");
  const [headers, setHeaders] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = (snapshot: Snapshot) => {
    setRecording(snapshot);
    setActions(JSON.stringify(snapshot.actions, null, 2));
    setEnvironmentRef(snapshot.environmentRef);
    setTarget(snapshot.target);
  };
  useEffect(() => {
    let cancelled = false;
    void api<Snapshot[]>("/ui-recordings")
      .then((items) => {
        if (cancelled) return;
        setHistory(items);
        const active = items.find((item) => item.state === "RECORDING");
        if (active) load(active);
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (recording?.state !== "RECORDING") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const snapshot = await api<Snapshot>(`/ui-recordings/${recording.id}`);
        if (!cancelled) load(snapshot);
      } catch (error) {
        if (!cancelled) setError(String(error));
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 1500);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [recording?.id, recording?.state]);
  const task = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const active = recording?.state === "RECORDING";
  return (
    <section>
      <h2>前置 UI 流程录制</h2>
      <p>
        录制登录及页面准备操作，审核后保存为 UI
        认证协议。接口执行前回放操作，并共享浏览器 Cookie。
      </p>
      <p>
        填写和下拉选择会保存实际输入值，回放时直接使用，无需配置 UI_INPUT
        环境变量。 可在动作 JSON 中修改 value；旧动作需将 secretRef 替换为
        value。 支持主页面点击、文本填写、下拉选择和 Enter 提交，暂不支持
        iframe、弹窗新页及复杂拖拽。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <label>
        前置 UI 环境
        <select
          aria-label="前置 UI 环境"
          disabled={active || busy}
          value={environmentRef}
          onChange={(e) => {
            setEnvironmentRef(e.target.value);
            setTarget(
              environments.find((item) => item.id === e.target.value)
                ?.baseURL ?? "",
            );
          }}
        >
          {environments.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        前置 UI 起始地址
        <input
          value={target}
          disabled={active || busy}
          onChange={(e) => setTarget(e.target.value)}
        />
      </label>
      <div className="toolbar">
        <button
          disabled={active || busy || !target || !environmentRef}
          onClick={() =>
            void task(async () => {
              load(
                await api<Snapshot>("/ui-recordings", {
                  target,
                  environmentRef,
                }),
              );
              setNotice(
                "请在打开的录制浏览器中完成登录和页面准备，再停止录制。",
              );
            })
          }
        >
          开始前置 UI 录制
        </button>
        <button
          disabled={!active || busy}
          onClick={() =>
            void task(async () => {
              load(
                await api<Snapshot>(`/ui-recordings/${recording!.id}/stop`, {}),
              );
              setHistory(await api<Snapshot[]>("/ui-recordings"));
              setNotice(
                "录制已保存，填写值已记录。请审核动作，可选填登录成功后的就绪元素。",
              );
            })
          }
        >
          停止前置 UI 录制
        </button>
      </div>
      <label>
        历史前置 UI 录制
        <select
          disabled={active || busy}
          value={recording?.id ?? ""}
          onChange={(e) => {
            const item = history.find((item) => item.id === e.target.value);
            if (item) load(item);
          }}
        >
          <option value="">选择录制</option>
          {history.map((item) => (
            <option key={item.id} value={item.id}>
              {item.target} · {item.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      {recording && (
        <>
          <p>
            {active ? "录制中" : "已停止"} · 共 {recording.actions.length}{" "}
            个动作
          </p>
          <label>
            前置 UI 动作 JSON
            <textarea
              className="json"
              disabled={active || busy}
              value={actions}
              onChange={(e) => setActions(e.target.value)}
            />
          </label>
          <AuthSourceHints
            hints={recording.authHints ?? []}
            disabled={active || busy}
            onApply={(hints) =>
              void task(async () => {
                const updated = applyAuthHints(
                  {
                    id: profileId || "draft",
                    actions: [],
                    readySelector: "body",
                    headers: JSON.parse(headers),
                    tokenSources: JSON.parse(tokens),
                    reauthenticateReads: false,
                  },
                  hints,
                );
                setTokens(JSON.stringify(updated.tokenSources, null, 2));
                setHeaders(JSON.stringify(updated.headers, null, 2));
                setNotice(
                  "已填入识别的来源与 Header 绑定，请审核并保存前置 UI 协议。",
                );
              })
            }
          />
          <label>
            前置 UI 协议 ID
            <input
              disabled={active || busy}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              placeholder="例如 evaluation-ui-auth"
            />
          </label>
          <label>
            前置 UI 就绪元素
            <input
              disabled={active || busy}
              value={readySelector}
              onChange={(e) => setReadySelector(e.target.value)}
              placeholder="可选，留空仅等待网络稳定"
            />
          </label>
          <p>
            就绪元素为可选项；填写时先等待元素可见。随后等待所有页面的 HTTP
            请求结束，并连续 1 秒没有新请求，再开始调用 API。网络等待最多 30
            秒，超时停止执行；轮询或流式请求可能导致超时。
          </p>
          <p>
            Cookie 自动共享。仅在接口还需要额外 Token Header
            时配置下面两项；tokenSources 支持前置接口的 JSON / 响应
            Header、Cookie、localStorage 和 sessionStorage，Header 的
            AUTH_CONTEXT.name 引用其逻辑名称。
          </p>
          <label>
            前置 UI Token 来源 JSON
            <textarea
              disabled={active || busy}
              value={tokens}
              onChange={(e) => setTokens(e.target.value)}
              placeholder={
                '{"pageToken":{"storageKey":"实际存储键","prefix":""}}'
              }
            />
          </label>
          <label>
            前置 UI Header 绑定 JSON
            <textarea
              disabled={active || busy}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder={
                '{"x-page-token":{"source":"AUTH_CONTEXT","name":"pageToken"}}'
              }
            />
          </label>
          <button
            disabled={active || busy || !profileId.trim()}
            onClick={() =>
              void task(async () => {
                const profile = await api<AuthProfile>("/auth-profiles", {
                  id: profileId.trim(),
                  actions: JSON.parse(actions),
                  readySelector: readySelector.trim(),
                  tokenSources: JSON.parse(tokens),
                  headers: JSON.parse(headers),
                  recordingRef: recording.id,
                  environmentRef,
                });
                await onSaved(profile);
                setNotice(
                  `前置 UI 协议 ${profile.id} 已保存，请在生成调用计划时选择该协议。`,
                );
              })
            }
          >
            保存前置 UI 协议
          </button>
        </>
      )}
    </section>
  );
}
