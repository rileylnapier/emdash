import { Tooltip } from '@emdash/ui/react/primitives';
import { QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useIntegrationAccountEvents } from '@core/features/integrations/api/browser/use-integration-account-events';
import { IntegrationsProvider } from '@core/features/integrations/contributions/browser/integrations-provider';
import { TaixuShell } from '@core/features/taixu/browser/taixu-shell';
import { TerminalPoolProvider } from '@core/features/terminals/browser/pty/pty-pool-provider';
import { confirmOpenExternalLink } from '@core/features/workbench/api/browser/open-external-link';
import { FramelessTitlebarOverlay } from '@core/features/workbench/browser/window-controls';
import { WorkspaceLayoutContextProvider } from '@core/features/workbench/contributions/browser/layout-provider';
import { ExternalLinkProvider } from '@core/primitives/external-links/browser';
import { queryClient } from '@core/primitives/query/browser/query-client';
import { HostRecoveryWakeups } from '@core/services/hosts/browser/recovery-wakeups';
import { reportAppQueriesSettled } from '@renderer/lib/boot/splash-gate';
import { AppMenuEvents } from './app/app-menu-events';
import { AppShutdownLifecycle } from './app/app-shutdown-lifecycle';
import { Workspace } from './app/workspace';
import { WorkspaceViewProvider } from './lib/layout/provider';
import { ModalRenderer } from './lib/modal/modal-renderer';
import { FeatureFlagProvider } from './lib/providers/feature-flag-override-context';
import { ThemeProvider } from './lib/providers/theme-provider';

export const HAS_SEEN_ONBOARDING = 'emdash:has-seen-onboarding:v1';

function AppContent() {
  useIntegrationAccountEvents();
  const [inspecting, setInspecting] = useState(false);
  useEffect(() => {
    reportAppQueriesSettled();
  }, []);
  const handleOpenSettingsFromMenu = useCallback(() => {
    setInspecting(true);
    return true;
  }, []);

  return (
    <Tooltip.Provider delay={300}>
      <WorkspaceLayoutContextProvider>
        <TerminalPoolProvider>
          <IntegrationsProvider>
            <WorkspaceViewProvider>
              <AppMenuEvents onOpenSettings={handleOpenSettingsFromMenu} />
              <ExternalLinkProvider openExternalLink={confirmOpenExternalLink}>
                <ThemeProvider>
                  <ModalRenderer />
                  <AppShutdownLifecycle />
                  <HostRecoveryWakeups />
                  <FramelessTitlebarOverlay />
                  <TaixuShell
                    inspecting={inspecting}
                    onInspect={setInspecting}
                    workbench={<Workspace active={inspecting} />}
                  />
                </ThemeProvider>
              </ExternalLinkProvider>
            </WorkspaceViewProvider>
          </IntegrationsProvider>
        </TerminalPoolProvider>
      </WorkspaceLayoutContextProvider>
    </Tooltip.Provider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <FeatureFlagProvider>
        <AppContent />
      </FeatureFlagProvider>
    </QueryClientProvider>
  );
}
