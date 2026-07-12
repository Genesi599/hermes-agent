import { describe, expect, it } from "vitest";

import type { SessionInfo } from "./api";
import { flattenSessionsWithBranches } from "./session-branch-tree";

const session = (
  id: string,
  overrides: Partial<SessionInfo> = {},
): SessionInfo => ({
  ended_at: null,
  id,
  input_tokens: 0,
  is_active: false,
  last_active: 0,
  message_count: 1,
  model: null,
  output_tokens: 0,
  preview: null,
  source: "desktop",
  started_at: 0,
  title: id,
  tool_call_count: 0,
  ...overrides,
});

describe("flattenSessionsWithBranches", () => {
  it("places branches directly below their parent", () => {
    const parent = session("parent", { last_active: 20 });
    const branchA = session("branch-a", {
      last_active: 15,
      parent_session_id: "parent",
    });
    const branchB = session("branch-b", {
      last_active: 10,
      parent_session_id: "parent",
    });

    expect(flattenSessionsWithBranches([parent, branchA, branchB])).toEqual([
      { session: parent },
      { branchStem: "├─ ", session: branchA },
      { branchStem: "└─ ", session: branchB },
    ]);
  });

  it("renders nested branches with multi-level stems", () => {
    const parent = session("parent");
    const child = session("child", { parent_session_id: "parent" });
    const grandchild = session("grandchild", { parent_session_id: "child" });

    expect(flattenSessionsWithBranches([parent, child, grandchild])).toEqual([
      { session: parent },
      { branchStem: "└─ ", session: child },
      { branchStem: "   └─ ", session: grandchild },
    ]);
  });

  it("follows a compressed parent through its lineage root id", () => {
    const tip = session("tip", {
      _lineage_root_id: "root",
      last_active: 30,
    });
    const branch = session("branch", {
      parent_session_id: "root",
      last_active: 10,
    });

    expect(flattenSessionsWithBranches([tip, branch])).toEqual([
      { session: tip },
      { branchStem: "└─ ", session: branch },
    ]);
  });

  it("marks an orphaned page result as a branch", () => {
    const branch = session("branch", { parent_session_id: "missing" });

    expect(flattenSessionsWithBranches([branch])).toEqual([
      { branchStem: "└─ ", session: branch },
    ]);
  });
});
