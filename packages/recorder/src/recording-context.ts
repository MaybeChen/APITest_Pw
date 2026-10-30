import type { Recording } from "../../contracts/src/index.js";

export function requestPhase(
  recording: Recording,
  request: Recording["requests"][number],
) {
  const marker = [...(recording.phaseMarkers ?? [])]
    .reverse()
    .find((item) => item.at <= request.startedAt);
  if (marker) return marker.phase;
  if (recording.phaseMarkers?.length) return "INITIALIZATION" as const;
  if (!request.pageId) return undefined;
  const navigation = [...(recording.pageNavigations ?? [])]
    .filter(
      (item) =>
        item.pageId === request.pageId && item.startedAt <= request.startedAt,
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!navigation) return undefined;
  const interaction = recording.operations.some(
    (operation) =>
      operation.context.pageId === request.pageId &&
      operation.at >= navigation.startedAt &&
      operation.at <= request.startedAt &&
      ["click", "input", "change", "submit"].includes(operation.type),
  );
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
