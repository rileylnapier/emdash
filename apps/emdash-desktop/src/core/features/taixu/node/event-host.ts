import { createEventStreamHost } from '@emdash/wire/live';
import { taixuContract } from '../api/contract';

export const taixuWorkEvents = createEventStreamHost(taixuContract.workStarted);
