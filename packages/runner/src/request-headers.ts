import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { ClientRequest } from "node:http";

type RequestScope = {
  reportId: string;
  stepId: string;
  attempt: number;
  method: string;
  url: string;
  headerBlacklist?: string[];
  onHeaders?: (capture: {
    headers: Record<string, string | string[]>;
    rawHeaders: string;
  }) => void;
};
const scope = new AsyncLocalStorage<RequestScope>();
let subscribed = false;
const filteredRequests = new WeakSet<ClientRequest>();

function subscribe() {
  if (subscribed) return;
  subscribed = true;
  channel("http.client.request.created").subscribe((event) => {
    const current = scope.getStore();
    if (!current?.headerBlacklist?.length) return;
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
    // Remove headers before serialization, including Playwright-injected cookies.
    filteredRequests.add(request);
    for (const name of current.headerBlacklist) request.removeHeader(name);
  });
  channel("http.client.request.start").subscribe((event) => {
    if (process.env.RUN_LOG_RAW_HEADERS !== "true") return;
    const current = scope.getStore();
    if (!current) return;
    const request = (event as { request: ClientRequest }).request;
    const target = new URL(current.url);
    if (
      request.method !== current.method ||
      (!filteredRequests.has(request) &&
        String(request.getHeader("host")).toLowerCase() !==
          target.host.toLowerCase()) ||
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
    const headers: Record<string, string | string[]> = {};
    for (const line of rawHeaders.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 1) continue;
      const name = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      const previous = headers[name];
      headers[name] =
        previous === undefined
          ? value
          : [...(Array.isArray(previous) ? previous : [previous]), value];
    }
    const { onHeaders, ...metadata } = current;
    onHeaders?.({ headers, rawHeaders });
    console.info(
      `[API_REQUEST_HEADERS] ${JSON.stringify(metadata)}\n${rawHeaders}\n`,
    );
  });
}

export function withRawRequestHeaders<T>(
  current: RequestScope,
  send: () => Promise<T>,
): Promise<T> {
  if (
    process.env.RUN_LOG_RAW_HEADERS !== "true" &&
    !current.headerBlacklist?.length
  )
    return send();
  subscribe();
  return scope.run(current, send);
}
