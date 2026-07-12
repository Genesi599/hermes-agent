import type { SessionInfo } from "./api";

export interface SessionBranchEntry {
  branchStem?: string;
  session: SessionInfo;
}

const recency = (session: SessionInfo): number =>
  session.last_active || session.started_at || 0;

/** Keep branch conversations adjacent to their parent and add tree stems. */
export function flattenSessionsWithBranches(
  sessions: readonly SessionInfo[],
): SessionBranchEntry[] {
  if (sessions.length === 0) return [];

  const byVisibleId = new Map<string, SessionInfo>();
  for (const session of sessions) {
    byVisibleId.set(session.id, session);
    const rootId = session._lineage_root_id?.trim();
    if (rootId) byVisibleId.set(rootId, session);
  }

  const childrenByParent = new Map<string, SessionInfo[]>();
  const nestedIds = new Set<string>();

  for (const session of sessions) {
    const parentId = session.parent_session_id?.trim();
    if (!parentId) continue;

    const parent = byVisibleId.get(parentId);
    if (!parent || parent.id === session.id) continue;

    nestedIds.add(session.id);
    const siblings = childrenByParent.get(parent.id) ?? [];
    siblings.push(session);
    childrenByParent.set(parent.id, siblings);
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) => recency(right) - recency(left));
  }

  const groupRecencyMemo = new Map<string, number>();
  const groupRecency = (session: SessionInfo): number => {
    const cached = groupRecencyMemo.get(session.id);
    if (cached !== undefined) return cached;

    groupRecencyMemo.set(session.id, recency(session));
    const newest = (childrenByParent.get(session.id) ?? []).reduce(
      (value, child) => Math.max(value, groupRecency(child)),
      recency(session),
    );
    groupRecencyMemo.set(session.id, newest);
    return newest;
  };

  const output: SessionBranchEntry[] = [];
  const seen = new Set<string>();

  const emit = (
    session: SessionInfo,
    ancestorsLast: readonly boolean[] = [],
    isLast = true,
  ) => {
    if (seen.has(session.id)) return;
    seen.add(session.id);

    const branchStem = ancestorsLast.length
      ? `${ancestorsLast
          .slice(0, -1)
          .map((last) => (last ? "   " : "│  "))
          .join("")}${isLast ? "└─ " : "├─ "}`
      : undefined;
    output.push(branchStem ? { branchStem, session } : { session });

    const children = childrenByParent.get(session.id) ?? [];
    children.forEach((child, index) =>
      emit(child, [...ancestorsLast, isLast], index === children.length - 1),
    );
  };

  sessions
    .filter((session) => !nestedIds.has(session.id))
    .map((session, index) => ({ index, session }))
    .sort(
      (left, right) =>
        groupRecency(right.session) - groupRecency(left.session) ||
        left.index - right.index,
    )
    .forEach(({ session }) => {
      const parentId = session.parent_session_id?.trim();
      const isOrphanBranch = Boolean(parentId && !byVisibleId.has(parentId));
      emit(session, isOrphanBranch ? [true] : []);
    });

  // A parent can fall outside the current paginated/search result. Keep the
  // child visible and mark it as a branch rather than pretending it is a root.
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    const branchStem = session.parent_session_id?.trim() ? "└─ " : undefined;
    output.push(branchStem ? { branchStem, session } : { session });
  }

  return output;
}
