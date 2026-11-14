import {
  awaitWirePort,
  client,
  connect,
  domPortTransport,
  type DomPortLike,
} from '@emdash/wire/rpc';
import { STUDIO_CONTROL_CHANNEL, studioControlContract } from '../studio-contract';

let pending: ReturnType<typeof open> | undefined;
async function open() {
  const port = awaitWirePort(window, { channel: STUDIO_CONTROL_CHANNEL });
  await window.electronAPI.requestWirePort(STUDIO_CONTROL_CHANNEL);
  return client(
    studioControlContract,
    connect(domPortTransport((await port) as DomPortLike), { callTimeoutMs: 120000 })
  );
}
export const getStudioClient = () => (pending ??= open());
let remoteDesktop = false;
let computerName: string | null = null;
export function setStudioDesktop(value: boolean, name?: string | null) {
  remoteDesktop = value;
  computerName = value ? name?.trim() || 'Studio' : null;
}
export function getStudioComputerName() {
  return computerName;
}
export function isStudioDesktop() {
  return remoteDesktop;
}
