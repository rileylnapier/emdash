type ImportMetaWithEnv = ImportMeta & { env?: { DEV?: boolean; VITE_BUILD?: string } };

const env = (import.meta as ImportMetaWithEnv).env;
const isDev = env?.DEV === true;
const isCanary = env?.VITE_BUILD === 'canary';

export const APP_ID = isCanary ? 'life.taixu.canary' : 'life.taixu.desktop';
export const PRODUCT_NAME = isCanary ? 'Taixu Canary' : 'Taixu';
export const APP_NAME_LOWER = isCanary ? 'taixu-canary' : 'taixu';
export const LINUX_DESKTOP_ID = isCanary ? 'taixu-canary' : 'Taixu';
export const USER_DATA_DIR_NAME = isDev ? 'taixu-dev' : isCanary ? 'taixu-canary' : 'taixu';
export const UPDATE_CHANNEL = isCanary ? 'v1-canary' : 'v1-stable';
export const ARTIFACT_PREFIX = isCanary ? 'taixu-canary' : 'taixu';
export const R2_BASE_URL = 'https://releases.emdash.sh';
export const IS_CANARY = isCanary;

// This fork has no release feed. Never install upstream Emdash over Taixu.
export const UPDATES_ENABLED = false;
