import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { existingFolderStep } from "./AddProjectToMachineDialog.logic";

const laptop = EnvironmentId.make("laptop");
const owner = ProjectId.make("owner");

function ownerAt(archivedAt: string | null): EnvironmentProject {
  return {
    environmentId: laptop,
    id: owner,
    title: "Repo",
    workspaceRoot: "/home/me/code/repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
  };
}

describe("existingFolderStep", () => {
  it.each([
    ["no project owns the folder", [], { kind: "create" }],
    ["an active project owns it", [ownerAt(null)], { kind: "open", projectId: owner }],
    [
      "an archived project owns it",
      [ownerAt("2026-11-01T00:00:00.000Z")],
      { kind: "unarchive", projectId: owner },
    ],
  ] as const)("when %s", (_case, projects, expected) => {
    expect(
      existingFolderStep({ projects, environmentId: laptop, resolvedPath: "/home/me/code/repo" }),
    ).toEqual(expected);
  });
});
