import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { TaixuUpdateState } from '../api/update-contract';
import {
  retainSharedUpdates,
  sharedUpdateStatus,
  showSharedUpdates,
  subscribeSharedUpdateStatus,
} from './update-controls';

/** Keep the window's single Taixu update control (and its restart hold) mounted. */
export function useSharedUpdates() {
  useEffect(() => retainSharedUpdates(), []);
}

export function useTaixuUpdateStatus() {
  return useSyncExternalStore(subscribeSharedUpdateStatus, sharedUpdateStatus);
}

type Labels = Partial<Record<TaixuUpdateState['status'], string>>;
const attention: Labels = {
  ready: 'Taixu update ready',
  blocked: 'Taixu update ready',
  downloading: 'Taixu update downloading',
};

/** A dot beside "Apps" while a Taixu update needs a look, named for screen readers. */
export function UpdateBadge() {
  const status = useTaixuUpdateStatus();
  const label = status && attention[status];
  if (!label) return null;
  return (
    <>
      <span className="taixu-update-dot" aria-hidden="true" />
      <span className="taixu-visually-hidden"> · {label}</span>
    </>
  );
}

const headline: Labels = {
  ready: 'Update ready',
  blocked: 'Update ready',
  downloading: 'Downloading…',
  preparing: 'Checking readiness…',
  installing: 'Restarting…',
};

/** Shows the window's update control in place, without starting another poller. */
export function TaixuUpdateCard() {
  const slot = useRef<HTMLDivElement>(null);
  const status = useTaixuUpdateStatus();
  useEffect(() => {
    const release = retainSharedUpdates();
    const hide = slot.current ? showSharedUpdates(slot.current) : () => {};
    return () => {
      hide();
      release();
    };
  }, []);
  return (
    <article className="taixu-app-card taixu-update-card" aria-label="Taixu">
      <div className="taixu-app-card-heading">
        <h3>Taixu</h3>
        {status && headline[status] && <span data-state={status}>{headline[status]}</span>}
      </div>
      <div ref={slot} />
    </article>
  );
}
