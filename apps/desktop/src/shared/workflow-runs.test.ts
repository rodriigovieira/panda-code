import { describe, expect, it } from "vitest";
import { parseWorkflowRuns } from "./workflow-runs";

const run = (id: number, conclusion = "success") => ({
  databaseId: id,
  name: "CI",
  displayTitle: `Commit ${id}`,
  status: "completed",
  conclusion,
  headBranch: "main",
  event: "push",
  createdAt: "2026-09-07T10:00:00Z",
  updatedAt: "2026-09-07T10:01:00Z",
  url: `https://github.com/example/repo/actions/runs/${id}`,
});

describe("parseWorkflowRuns", () => {
  it("keeps the requested newest runs and reports another page", () => {
    const parsed = parseWorkflowRuns(JSON.stringify([run(3), run(2, "failure"), run(1)]), 2);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.runs.map((item) => item.databaseId)).toEqual([3, 2]);
    expect(parsed.runs[1]?.conclusion).toBe("failure");
  });

  it("drops malformed rows without inventing links or ids", () => {
    const parsed = parseWorkflowRuns(JSON.stringify([{}, run(1), null]), 10);
    expect(parsed).toMatchObject({ hasMore: false, runs: [{ databaseId: 1 }] });
  });

  it("rejects a non-array response", () => {
    expect(() => parseWorkflowRuns("{}", 10)).toThrow("Unexpected response");
  });
});
