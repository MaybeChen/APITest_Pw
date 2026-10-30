import type { Recording } from "../../contracts/src/index.js";

export function requestPhase(
  recording: Recording,
  request: Recording["requests"][number],
) {
  const marker = [...(recording.phaseMarkers ?? [])]
    .reverse()
    .find((item) => item.at <= request.startedAt);
  const navigation = [...(recording.pageNavigations ?? [])]
    .filter(
      (item) =>
        item.pageId === request.pageId && item.startedAt <= request.startedAt,
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const interaction = recording.operations.some(
    (operation) =>
      operation.context.pageId === request.pageId &&
      operation.at >= (navigation?.startedAt ?? Infinity) &&
      operation.at <= request.startedAt &&
      ["click", "input", "change", "submit"].includes(operation.type),
  );
  if (marker) {
    // A global business marker does not make a newly opened page's bootstrap calls business calls.
    if (navigation && navigation.startedAt > marker.at && !interaction)
      return "INITIALIZATION" as const;
    return marker.phase;
  }
  if (recording.phaseMarkers?.length) return "INITIALIZATION" as const;
  if (!request.pageId || !navigation) return undefined;
  return interaction ? ("BUSINESS" as const) : ("INITIALIZATION" as const);
}

export function initializationCandidates(
  recording: Recording,
  selectedNavigationIds?: string[],
) {
  const candidates = new Map<
    string,
    NonNullable<Recording["applicationCandidates"]>[number]
  >();
  const navigations = (recording.pageNavigations ?? []).filter(
    (item) =>
      item.status &&
      item.status >= 200 &&
      item.status < 300 &&
      /(?:text\/html|application\/xhtml)/i.test(item.contentType ?? "") &&
      !/\/(?:login|logout|dspcas|oauth2?|sso)(?:\/|$)/i.test(
        new URL(item.url).pathname,
      ) &&
      !item.url.includes("[REDACTED]"),
  );
  for (const request of recording.requests.filter((item) => item.keep)) {
    const navigation = navigations
      .filter(
        (item) =>
          item.startedAt <= request.startedAt &&
          (!request.pageId || item.pageId === request.pageId),
      )
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!navigation) continue;
    const entry = new URL(recording.target);
    const target = new URL(navigation.url);
    // The recording entry page belongs to the shared prerequisite UI, not application initialization.
    if (
      !navigation.newWindow &&
      entry.origin === target.origin &&
      entry.pathname === target.pathname &&
      entry.search === target.search
    )
      continue;
    const previous = recording.applicationCandidates?.find(
      (item) => item.navigationId === navigation.id,
    );
    const candidate = candidates.get(navigation.id) ?? {
      navigationId: navigation.id,
      url: navigation.url,
      newWindow: navigation.newWindow,
      requestIds: [],
      enabled: selectedNavigationIds
        ? selectedNavigationIds.includes(navigation.id)
        : (previous?.enabled ?? true),
    };
    candidate.requestIds.push(request.id);
    candidates.set(navigation.id, candidate);
  }
  return [...candidates.values()];
}

export function usefulInitializationDependency(
  edge: Recording["dependencies"][number],
  from: Recording["requests"][number],
  to: Recording["requests"][number],
) {
  const normalize = (value: string) =>
    value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const source = normalize(edge.path.match(/\.([^.[\]]+)$/)?.[1] ?? "");
  const target = normalize(
    edge.targetKey?.match(/(?:^|\.)([^.[\]]+)$/)?.[1] ?? "",
  );
  if (/^(?:tenantid|locale|sessionid|userid|ownerid)$/.test(source))
    return false;
  if (!["id", "name", "key", ""].includes(source) && source === target)
    return true;
  const resource = (url: string) =>
    new URL(url).pathname
      .split("/")
      .filter(
        (segment) =>
          segment &&
          !/^\d+$/.test(segment) &&
          !/^(?:api|web|rest|v\d+|list|query|search|detail|info|save|create|update|delete|get|page)$/i.test(
            segment,
          ),
      )
      .at(-1)
      ?.toLowerCase()
      .replace(/s$/, "") ?? "";
  const left = resource(from.url),
    right = resource(to.url);
  if (left && edge.targetLocation === "PATH" && edge.targetKey) {
    const parent = new URL(to.url).pathname.split("/").filter(Boolean)[
      Number(edge.targetKey) - 1
    ];
    if (parent && normalize(parent).replace(/s$/, "") === normalize(left))
      return true;
  }
  return !!left && left === right;
}
