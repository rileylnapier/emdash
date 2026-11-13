import type { ContractClient } from '@emdash/wire/rpc';
import { domainClient } from '@core/primitives/wire/browser/connection';
import { taixuContract, taixuDomain } from '../contract';

export function getTaixuClient(): Promise<ContractClient<typeof taixuContract>> {
  return domainClient(taixuDomain, taixuContract);
}
