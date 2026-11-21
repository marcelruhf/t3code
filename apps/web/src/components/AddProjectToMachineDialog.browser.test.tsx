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
  let clone = (): Promise<unknown> => Promise.resolve(null);
  const createProject = vi.fn<(value: unknown) => Promise<unknown>>();
  return {
    // Each test chooses the machines it can clone to and how the clone answers.
    setup: (next: { targets: ReadonlyArray<unknown>; clone: () => Promise<unknown> }) => {
      targets = next.targets;
      clone = next.clone;
      createProject.mockReset();
      createProject.mockResolvedValue({ _tag: "Success" });
    },
    targets: () => targets,
    clone: () => clone(),
    createProject,
  };
});

vi.mock(import("../state/entities"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    readProject: (() => project.get()) as never,
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
  useNewThreadHandler: (() => () => undefined) as never,
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
  useAtomCommand: (() => machine.createProject) as never,
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

describe("AddProjectToMachineDialog", () => {
  it("offers to add the folder as the project while the clone destination is taken", async () => {
    project.setup(PROJECT);
    const laptop = EnvironmentId.make("laptop");
    machine.setup({
      targets: [{ environmentId: laptop, label: "Laptop", machine: "laptop" }],
      clone: () =>
        Promise.reject(
          new SourceControlRepositoryError({
            provider: SourceControlProviderKind.make("unknown"),
            operation: "cloneRepository",
            detail: "Destination path already exists and is not empty.",
            reason: "destination-not-empty",
          }),
        ),
    });
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
      expect(machine.createProject).toHaveBeenCalledWith({
        environmentId: laptop,
        input: expect.objectContaining({
          workspaceRoot: "~/code/repo",
          createWorkspaceRootIfMissing: false,
        }),
      }),
    );
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
