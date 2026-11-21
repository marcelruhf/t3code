import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";

const project = vi.hoisted(() => {
  let value: unknown = null;
  const listeners = new Set<() => void>();
  return {
    // Each test starts from no project and no listeners left by an earlier test.
    setup: (initial: unknown) => {
      value = initial;
      listeners.clear();
    },
    get: () => value,
    set: (next: unknown) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

const machine = vi.hoisted(() => {
  let targets: ReadonlyArray<unknown> = [];
  let projects: ReadonlyArray<unknown> = [];
  let clone = (): Promise<unknown> => Promise.resolve(null);
  // Project create and update both run through this one command mock.
  const runCommand = vi.fn<(value: unknown) => Promise<unknown>>();
  const openThread = vi.fn<(ref: unknown) => void>();
  return {
    // Each test chooses the machines it can clone to, their projects, and how the clone answers.
    setup: (next: {
      targets: ReadonlyArray<unknown>;
      projects?: ReadonlyArray<unknown>;
      clone: () => Promise<unknown>;
    }) => {
      targets = next.targets;
      projects = next.projects ?? [];
      clone = next.clone;
      runCommand.mockReset();
      runCommand.mockResolvedValue({ _tag: "Success" });
      openThread.mockReset();
    },
    targets: () => targets,
    projects: () => projects,
    clone: () => clone(),
    runCommand,
    openThread,
  };
});

vi.mock(import("../state/entities"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    readProject: (() => project.get()) as never,
    readProjects: (() => machine.projects()) as never,
    subscribeProject: ((_ref: unknown, listener: (value: unknown) => void) =>
      project.subscribe(() => listener(project.get()))) as never,
    useProject: (() => useSyncExternalStore(project.subscribe, project.get)) as never,
  };
});
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
}));
vi.mock(import("../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => machine.openThread) as never,
}));
vi.mock(import("../hooks/useAddProjectTargets"), async (original) => ({
  ...(await original()),
  useAddProjectTargets: (() => machine.targets()) as never,
}));
vi.mock(import("../hooks/useLogicalProjectEnvironments"), async (original) => ({
  ...(await original()),
  useLogicalProjectEnvironments: (() => []) as never,
}));

vi.mock(import("../lib/addProjectToMachine"), async (original) => ({
  ...(await original()),
  addProjectToMachine: (() => machine.clone()) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => machine.runCommand) as never,
}));

import {
  AddProjectToMachineDialogHost,
  openAddProjectToMachine,
} from "./AddProjectToMachineDialog";

const environmentId = EnvironmentId.make("environment-1");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
const PROJECT = {
  environmentId,
  id: projectRef.projectId,
  title: "Repo",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
};
const laptop = EnvironmentId.make("laptop");
const LAPTOP_TARGET = { environmentId: laptop, label: "Laptop", machine: "laptop" };
// The server reports the folder resolved, as stored projects record it.
const refuseOccupiedFolder = () =>
  Promise.reject(
    new SourceControlRepositoryError({
      provider: SourceControlProviderKind.make("unknown"),
      operation: "cloneRepository",
      detail: "Destination path already exists and is not empty.",
      occupiedDestination: "/home/me/code/repo",
    }),
  );

describe("AddProjectToMachineDialog", () => {
  it("offers to add the folder as the project while the clone destination is taken", async () => {
    project.setup(PROJECT);
    machine.setup({ targets: [LAPTOP_TARGET], clone: refuseOccupiedFolder });
    await using screen = await render(<AddProjectToMachineDialogHost />);
    await act(() => openAddProjectToMachine({ projectRef, targetEnvironmentId: laptop }));
    const folder = screen.getByLabelText("Folder on Laptop");
    await userEvent.fill(folder, "~/code/repo");

    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("button", { name: "Add existing folder" })).toBeVisible();
    await userEvent.fill(folder, "~/code/other");
    await expect.element(screen.getByRole("button", { name: "Clone to Laptop" })).toBeVisible();
    await userEvent.fill(folder, "~/code/repo");
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(machine.runCommand).toHaveBeenCalledWith({
        environmentId: laptop,
        input: expect.objectContaining({
          workspaceRoot: "/home/me/code/repo",
          createWorkspaceRootIfMissing: false,
        }),
      }),
    );
  });

  it("opens the project that already owns the taken folder instead of adding another", async () => {
    project.setup(PROJECT);
    const owner = ProjectId.make("laptop-project");
    machine.setup({
      targets: [LAPTOP_TARGET],
      projects: [
        {
          environmentId,
          id: ProjectId.make("same-path-elsewhere"),
          workspaceRoot: "/home/me/code/repo",
        },
        {
          environmentId: laptop,
          id: owner,
          workspaceRoot: "/home/me/code/repo/",
          archivedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
      clone: refuseOccupiedFolder,
    });
    await using screen = await render(<AddProjectToMachineDialogHost />);
    await act(() => openAddProjectToMachine({ projectRef, targetEnvironmentId: laptop }));
    await userEvent.fill(screen.getByLabelText("Folder on Laptop"), "~/code/repo");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("button", { name: "Add existing folder" })).toBeVisible();

    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(machine.openThread).toHaveBeenCalledWith(scopeProjectRef(laptop, owner)),
    );
    expect(machine.runCommand.mock.calls).toEqual([
      [{ environmentId: laptop, input: { projectId: owner, archived: false } }],
    ]);
  });

  it("closes when its project goes away", async () => {
    project.setup(PROJECT);
    machine.setup({ targets: [], clone: () => Promise.resolve(null) });
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => openAddProjectToMachine({ projectRef, targetEnvironmentId: null }));
    await expect.element(screen.getByText("Add to another machine")).toBeInTheDocument();

    await act(() => project.set(null));
    await act(() => project.set(PROJECT));
    await expect.element(screen.getByText("Add to another machine")).not.toBeInTheDocument();
  });

  it("does not reopen for a project that vanished before the dialog showed", async () => {
    project.setup(PROJECT);
    machine.setup({ targets: [], clone: () => Promise.resolve(null) });
    await using screen = await render(<AddProjectToMachineDialogHost />);

    await act(() => {
      openAddProjectToMachine({ projectRef, targetEnvironmentId: null });
      project.set(null);
    });
    await act(() => project.set(PROJECT));

    await expect.element(screen.getByText("Add to another machine")).not.toBeInTheDocument();
  });
});
