import { toast } from '@emdash/ui/react/primitives';
import { openModal } from '@core/manifests/browser/modal-api';
import type { WorkTarget } from '../contract';
import { getTaixuClient } from './client';

let reviewing = false;

/** All native archive entry points review context before closing sessions or removing files. */
export async function reviewWorkArchives(targets: readonly WorkTarget[]): Promise<void> {
  if (reviewing || !targets.length) return;
  reviewing = true;
  try {
    const client = await getTaixuClient();
    for (const target of targets) {
      const outcome = await openModal('taixuArchiveModal', { ...target, client });
      // Bulk actions review one task at a time and stop when the user cancels.
      if (!outcome.success) break;
    }
  } catch {
    toast.error('Could not open the archive. Reconnect and try again.');
  } finally {
    reviewing = false;
  }
}
