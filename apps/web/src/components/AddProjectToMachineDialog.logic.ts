import { findExistingAddProject } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

export type ExistingFolderStep =
  | { readonly kind: "create" }
  | { readonly kind: "unarchive"; readonly projectId: ProjectId }
  | { readonly kind: "open"; readonly projectId: ProjectId };

/** A server refuses a second project for a folder, archived owners included. */
export function existingFolderStep(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId;
  readonly resolvedPath: string;
}): ExistingFolderStep {
  const owner = findExistingAddProject({
    projects: input.projects,
    environmentId: input.environmentId,
    path: input.resolvedPath,
  });
  if (owner === null) return { kind: "create" };
  return owner.archivedAt == null
    ? { kind: "open", projectId: owner.id }
    : { kind: "unarchive", projectId: owner.id };
}
