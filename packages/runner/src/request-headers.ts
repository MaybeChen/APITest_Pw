import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { ClientRequest } from "node:http";

type RequestScope = {
  reportId: string;
  stepId: string;
  attempt: number;
  method: string;
  url: string;
};
const scope = new AsyncLocalStorage<RequestScope>();
let subscribed = false;

function subscribe() {
  if (subscribed) return;
  subscribed = true;
  channel("http.client.request.start").subscribe((event) => {
    const current = scope.getStore();
    if (!current) return;
    const request = (event as { request: ClientRequest }).request;
    const target = new URL(current.url);
    if (
      request.method !== current.method ||
      String(request.getHeader("host")).toLowerCase() !==
        target.host.toLowerCase() ||
      (request.path !== target.pathname + target.search &&
        request.path !== target.href)
    )
      return;
    // Node has serialized all outgoing headers at this event, including implicit
    // transport headers. Reading this snapshot leaves Playwright's request intact.
    const serialized = (request as ClientRequest & { _header?: string })
      ._header;
    const rawHeaders = serialized
      ? serialized.split("\r\n").slice(1).filter(Boolean).join("\r\n")
      : Object.entries(request.getHeaders())
          .flatMap(([name, value]) =>
            (Array.isArray(value) ? value : [value]).map(
              (item) => `${name}: ${item}`,
            ),
          )
          .join("\r\n");
    console.info(
      `[API_REQUEST_HEADERS] ${JSON.stringify(current)}\n${rawHeaders}\n`,
    );
  });
}

export function withRawRequestHeaders<T>(
  current: RequestScope,
  send: () => Promise<T>,
): Promise<T> {
  if (process.env.RUN_LOG_RAW_HEADERS !== "true") return send();
  subscribe();
  return scope.run(current, send);
}
