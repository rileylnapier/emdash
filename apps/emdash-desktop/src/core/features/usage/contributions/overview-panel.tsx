import { UsageOverview } from '../browser/usage-settings-page';

/** Embed the live usage overview without depending on the settings navigation host. */
export function UsageOverviewPanel() {
  return <UsageOverview embedded />;
}
