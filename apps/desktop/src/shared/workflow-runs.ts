import type { WorkspaceWorkflowRun } from "./ipc";

/** Parse the bounded JSON array produced by `gh run list --json …`. */
export function parseWorkflowRuns(stdout: string, limit: number): { runs: WorkspaceWorkflowRun[]; hasMore: boolean } {
  const raw = JSON.parse(stdout) as unknown;
  if (!Array.isArray(raw)) throw new Error("Unexpected response");

  const runs: WorkspaceWorkflowRun[] = raw.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (typeof item.databaseId !== "number" || typeof item.url !== "string") return [];
    return [{
      databaseId: item.databaseId,
      name: typeof item.name === "string" ? item.name : "Workflow",
      displayTitle: typeof item.displayTitle === "string" ? item.displayTitle : "",
      status: typeof item.status === "string" ? item.status : "unknown",
      conclusion: typeof item.conclusion === "string" && item.conclusion ? item.conclusion : undefined,
      headBranch: typeof item.headBranch === "string" ? item.headBranch : "",
      event: typeof item.event === "string" ? item.event : "",
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
      url: item.url,
    }];
  });

  const hasMore = runs.length > limit;
  return { runs: hasMore ? runs.slice(0, limit) : runs, hasMore };
}
