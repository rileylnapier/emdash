import '@emdash/ui/style.css';
import { Dialog } from '@emdash/ui/react/primitives';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import {
  AddProjectModal,
  type Mode,
} from '@core/features/projects/browser/components/add-project-modal/add-project-modal';
import type { ProjectDirectoryPickerClient } from '@core/features/projects/browser/components/add-project-modal/project-directory-picker';
import { DirectorySelectorModal } from '@core/features/projects/browser/components/directory-selector-modal';
import {
  getStudioComputerName,
  setStudioDesktop,
} from '@core/features/taixu/api/browser/studio-client';

const mocks = vi.hoisted(() => ({
  openDirectory: vi.fn(),
  nativeDirectory: vi.fn(),
  complete: vi.fn(),
  dismiss: vi.fn(),
  setCloseGuard: vi.fn(),
  startCreation: vi.fn(),
  home: vi.fn(),
  defaultRoot: vi.fn(),
  list: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => mocks.openDirectory,
  useModalController: () => ({
    complete: mocks.complete,
    dismiss: mocks.dismiss,
    setCloseGuard: mocks.setCloseGuard,
  }),
}));
vi.mock('@core/primitives/desktop-host/browser/host-client', () => ({
  getHostClient: async () => ({ openSelectDirectoryDialog: mocks.nativeDirectory }),
}));
vi.mock('@core/features/projects/api/browser/client', () => ({
  getProjectsWireClient: async () => ({
    getHostHomeDir: mocks.home,
    getDefaultRepositoriesRoot: mocks.defaultRoot,
    listHostDirectory: mocks.list,
    inspectProjectPath: mocks.inspect,
  }),
}));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ startProjectCreation: mocks.startCreation }),
  getProjectSettingsStore: () => undefined,
}));
vi.mock('@core/features/machines/contributions/app-stores', () => ({
  getMachinesStore: () => ({ connections: [] }),
}));
vi.mock('@core/features/integrations/api/browser/use-provider-accounts', () => ({
  useAccounts: () => ({
    data: [
      {
        providerId: 'github',
        accountId: 'test',
        displayName: 'Test account',
        host: 'github.com',
        login: 'test',
        avatarUrl: '',
        credentialSource: 'cli',
        isDefault: true,
      },
    ],
    isPending: false,
  }),
}));
vi.mock('@core/features/repository/api/browser/use-repository-owner-select', () => ({
  useRepositoryOwnerSelect: () => ({
    owners: [{ value: 'test', label: 'test' }],
    owner: { value: 'test', label: 'test' },
    errorMessage: null,
    handleOwnerChange: vi.fn(),
  }),
}));
vi.mock('@core/primitives/navigation/browser/navigation-hooks', () => ({
  useNavigate: () => ({ navigate: vi.fn() }),
}));
vi.mock('@core/primitives/keybindings/browser/confirm-button', async () => {
  const { Button } = await import('@emdash/ui/react/primitives');
  return { ConfirmButton: Button };
});

describe('project location on the selected Taixu computer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setStudioDesktop(false);
    mocks.defaultRoot.mockResolvedValue({ success: true, data: '/Users/test/repos' });
    mocks.home.mockResolvedValue('/Users/test');
    mocks.list.mockResolvedValue({ success: true, data: { entries: [] } });
    mocks.inspect.mockResolvedValue({ isDirectory: true, isGitRepo: true });
    mocks.openDirectory.mockResolvedValue({
      success: true,
      data: { path: '/Users/test/repos/example' },
    });
    mocks.nativeDirectory.mockResolvedValue('/Users/test/repos/example');
    mocks.startCreation.mockResolvedValue({
      projectId: 'test-project',
      completion: Promise.resolve({ success: true }),
    });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    setStudioDesktop(false);
  });

  async function render(component: ReactNode) {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Dialog.Root open>
            <Dialog.Content size="lg">{component}</Dialog.Content>
          </Dialog.Root>
        </QueryClientProvider>
      )
    );
  }

  async function chooseDirectory() {
    const field = document.querySelector<HTMLButtonElement>('[data-slot="directory-field"]');
    expect(field).not.toBeNull();
    await act(async () => field!.click());
  }

  for (const studio of [false, true]) {
    for (const mode of ['pick', 'create', 'clone'] as Mode[]) {
      it(`${studio ? 'Studio' : 'local'} ${mode} retains the chosen directory and backend ownership`, async () => {
        setStudioDesktop(studio, 'Mac Studio');
        await render(
          <AddProjectModal
            mode={mode}
            strategy={studio ? 'ssh' : undefined}
            connectionId={studio ? 'unused-extra-host' : undefined}
            navigateOnCreate={false}
            promptConfigImport={false}
          />
        );
        await expect.poll(() => mocks.defaultRoot.mock.calls.length).toBeGreaterThan(0);
        expect(mocks.defaultRoot).toHaveBeenCalledWith({ type: 'local' });
        const location = document.querySelector('[aria-label="Project location"]');
        expect(location?.textContent).toContain(studio ? 'Mac Studio' : 'Local');
        expect(location?.tagName === 'BUTTON').toBe(!studio);
        if (studio) {
          expect(document.body.textContent).toContain(
            'Repositories and workspaces stay on that computer.'
          );
          expect(document.body.textContent).not.toContain('No machines found');
        }
        await chooseDirectory();
        if (studio) {
          expect(mocks.openDirectory).toHaveBeenCalledWith(
            expect.objectContaining({ computerName: 'Mac Studio', connectionId: undefined })
          );
          expect(mocks.nativeDirectory).not.toHaveBeenCalled();
        } else {
          expect(mocks.nativeDirectory).toHaveBeenCalledOnce();
          expect(mocks.openDirectory).not.toHaveBeenCalled();
        }
        await expect
          .poll(() => document.querySelector('[data-slot="directory-field"]')?.textContent)
          .toContain('/Users/test/repos/example');
        if (mode === 'create')
          await page.getByPlaceholder('Enter a repository name').fill('example');
        if (mode === 'clone')
          await page
            .getByPlaceholder('Enter a repository URL')
            .fill('https://github.com/test/example.git');
        await page.getByRole('button', { name: 'Create', exact: true }).click();
        await expect.poll(() => mocks.startCreation.mock.calls.length).toBe(1);
        expect(mocks.startCreation).toHaveBeenCalledWith(
          { type: 'local' },
          expect.objectContaining({ mode, path: '/Users/test/repos/example' }),
          expect.objectContaining({ id: expect.any(String) })
        );
      });
    }
  }

  it('keeps the additional SSH host selector in local mode', async () => {
    await render(<AddProjectModal />);
    await page.getByRole('button', { name: 'Project location' }).click();
    await expect
      .element(page.getByText('Add a project from this computer.', { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText('Remote', { exact: true })).toBeVisible();
  });

  it('names the Studio in the picker and browses the backend-local host', async () => {
    const pickerClient = {
      getHostHomeDir: mocks.home,
      listHostDirectory: mocks.list,
    } as unknown as ProjectDirectoryPickerClient;
    await render(
      <DirectorySelectorModal
        computerName="Mac Studio"
        getProjectsClient={async () => pickerClient}
      />
    );
    await expect
      .element(page.getByRole('heading', { name: 'Select a directory on Mac Studio' }))
      .toBeVisible();
    await expect.poll(() => mocks.list.mock.calls.length).toBeGreaterThan(0);
    expect(mocks.home).toHaveBeenCalledWith({ type: 'local' });
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ host: { type: 'local' } }));
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    expect(mocks.complete).toHaveBeenCalledWith({ path: '/Users/test' });
  });

  it('clears the selected computer name when returning to this Mac', () => {
    setStudioDesktop(true, 'Mac Studio');
    expect(getStudioComputerName()).toBe('Mac Studio');
    setStudioDesktop(false);
    expect(getStudioComputerName()).toBeNull();
  });
});
