import { taixuArchiveModal, taixuArchiveListModal } from '../browser/work-archive-modal';
import { taixuFollowupModal } from '../browser/work-followup-modal';
import { taixuMergeModal } from '../browser/work-merge-modal';
export const taixuBrowserContributions = {
  modalDefs: [taixuFollowupModal, taixuMergeModal, taixuArchiveModal, taixuArchiveListModal],
} as const;
