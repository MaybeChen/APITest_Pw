// Browser-only script. Loaded by path, never serialized from a tsx callback.
"use strict";
(() => {
  const send = (event) => {
    // Reloads and closing frames can tear down the Playwright binding while
    // delayed AFTER snapshots are still queued. Do not leak rejected promises.
    try {
      Promise.resolve(window.__record(event)).catch(() => {});
    } catch {
      // The frame may already be navigating or closing.
    }
  };
  const safeText = (element) => {
    if (element.matches("input,textarea,select")) return "";
    const copy = element.cloneNode(true);
    copy
      .querySelectorAll("input,textarea,select,script,style")
      .forEach((el) => el.remove());
    return copy.textContent ?? "";
  };
  const snapshot = (operationId, phase, target) => {
    const region =
      target?.closest('form,[role="dialog"],dialog,section,main') ??
      target?.parentElement ??
      document.body;
    const visible = (element) =>
      element instanceof HTMLElement &&
      !!(
        element.offsetWidth ||
        element.offsetHeight ||
        element.getClientRects().length
      );
    const describe = (element) => {
      const field =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement;
      const sensitive =
        field &&
        /password|token|secret|card|cvv/i.test(
          element.getAttribute("name") ?? "",
        );
      return {
        tag: element.tagName,
        role: element.getAttribute("role") ?? undefined,
        label: sensitive
          ? "[REDACTED]"
          : (element.getAttribute("aria-label")?.slice(0, 100) ?? undefined),
        text: field ? undefined : safeText(element).slice(0, 120),
        name: element.getAttribute("name")?.slice(0, 100) ?? undefined,
        type: element.getAttribute("type") ?? undefined,
        disabled: element.hasAttribute("disabled"),
        expanded: element.getAttribute("aria-expanded") ?? undefined,
      };
    };
    send({
      snapshot: {
        id: crypto.randomUUID(),
        operationId,
        phase,
        at: Date.now(),
        url: location.href,
        title: document.title.slice(0, 160),
        headings: Array.from(
          document.querySelectorAll('h1,h2,[role="heading"]'),
        )
          .filter(visible)
          .slice(0, 6)
          .map((el) => safeText(el).slice(0, 120)),
        region: {
          tag: region?.tagName ?? "BODY",
          role: region?.getAttribute("role") ?? undefined,
          label: region?.getAttribute("aria-label")?.slice(0, 100) ?? undefined,
        },
        elements: Array.from(
          region?.querySelectorAll(
            'button,a,label,h1,h2,input,textarea,select,[role="button"]',
          ) ?? [],
        )
          .filter(visible)
          .slice(0, 24)
          .map(describe),
      },
    });
  };
  const emit = (type, target) => {
    const el = target instanceof HTMLElement ? target : null;
    const sensitive =
      el instanceof HTMLInputElement &&
      (el.type === "password" || /password|token|secret|card/i.test(el.name));
    const context = {
      tag: el?.tagName,
      role: el?.getAttribute("role"),
      accessibleName: el?.getAttribute("aria-label"),
      text: sensitive
        ? "[REDACTED]"
        : el
          ? safeText(el).slice(0, 160)
          : undefined,
      attributes: {
        id: el?.id,
        name: el?.getAttribute("name"),
        type: el?.getAttribute("type"),
      },
      value: "[OMITTED]",
      state: document.readyState,
    };
    const operationId = crypto.randomUUID();
    if (["click", "change", "submit"].includes(type))
      snapshot(operationId, "BEFORE", el);
    send({
      id: operationId,
      type,
      at: Date.now(),
      url: location.href,
      context,
      requestIds: [],
    });
    if (
      ["click", "change", "submit", "navigation", "stateChange"].includes(type)
    )
      setTimeout(
        () => snapshot(operationId, "AFTER", el?.isConnected ? el : null),
        200,
      );
  };
  for (const type of ["click", "input", "change", "submit"])
    document.addEventListener(type, (e) => emit(type, e.target), true);
  addEventListener("DOMContentLoaded", () => emit("navigation"));
  send({ recorderReady: true });
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => emit("stateChange"), 300);
  }).observe(document, { subtree: true, childList: true });
})();
