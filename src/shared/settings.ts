/**
 * Persistent settings and their storage rules.
 *
 *  - Everything lives in chrome.storage.local, which only trusted extension
 *    contexts may read (see the access level set by the service worker).
 *  - API keys never leave this device. v2 mirrored them into chrome.storage.sync;
 *    the migration removes them from there.
 *  - Only the profile text syncs across devices, newest write wins.
 */
import { isProviderId, PROVIDERS, type ProviderId } from './providers.ts';

export type Language = 'en' | 'zh_CN';

export interface ProviderConfig {
  apiKey: string;
  model: string;
}

export interface Settings {
  schemaVersion: 3;
  language: Language | null;
  provider: ProviderId;
  providers: Partial<Record<ProviderId, ProviderConfig>>;
  profile: string;
  profileUpdatedAt: number;
  quickQuery: boolean;
  overwrite: boolean;
}

/** The subset of chrome.storage.StorageArea this module uses; fakeable in tests. */
export interface StorageAreaLike {
  get(keys: string | string[] | null): Promise<Record<string, any>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface StorageLike {
  local: StorageAreaLike;
  sync: StorageAreaLike;
}

const SETTINGS_KEY = 'settings';
const SYNC_PROFILE_KEY = 'profile';
const SYNC_PROFILE_TS_KEY = 'profileUpdatedAt';

/** chrome.storage.sync rejects items larger than this. */
export const SYNC_ITEM_LIMIT_BYTES = 8192;

const LEGACY_KEYS = [
  'userProfile',
  'userProfile_ts',
  'selectedProvider',
  'providerConfigs',
  'quick_query_enabled',
  'correction_enabled',
  'correction_enabled_ts',
  'isFilling',
  'language',
];

export function defaultSettings(): Settings {
  return {
    schemaVersion: 3,
    language: null,
    provider: 'gemini',
    providers: {},
    profile: '',
    profileUpdatedAt: 0,
    quickQuery: false,
    overwrite: false,
  };
}

/* ------------------------------------------------------------------ */
/* Migration from v2                                                   */
/* ------------------------------------------------------------------ */

/** v2 stored the profile as a JSON-encoded array of entries, or as raw text. */
function legacyProfileText(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.join('\n---\n') : raw;
  } catch {
    return raw;
  }
}

/** Builds v3 settings from v2 data. v2 read sync first, so sync wins here too. */
export function migrateLegacy(
  local: Record<string, any>,
  sync: Record<string, any>
): Settings | null {
  const hasLegacy = LEGACY_KEYS.some((key) => key in local || key in sync);
  if (!hasLegacy) return null;

  const pick = (key: string) => sync[key] ?? local[key];
  const syncIsNewer = (sync.userProfile_ts ?? 0) > (local.userProfile_ts ?? 0);
  const rawProfile = syncIsNewer
    ? (sync.userProfile ?? local.userProfile)
    : (local.userProfile ?? sync.userProfile);

  const settings = defaultSettings();
  settings.profile = legacyProfileText(rawProfile);
  settings.profileUpdatedAt = Math.max(sync.userProfile_ts ?? 0, local.userProfile_ts ?? 0);

  const selected = pick('selectedProvider');
  settings.provider = isProviderId(selected) ? selected : 'openai';

  const configs: Record<string, { apiKey?: string; modelId?: string }> = {
    ...local.providerConfigs,
    ...sync.providerConfigs,
  };
  for (const [id, config] of Object.entries(configs)) {
    if (isProviderId(id)) {
      settings.providers[id] = { apiKey: config?.apiKey ?? '', model: config?.modelId ?? '' };
    }
  }

  settings.quickQuery = !!pick('quick_query_enabled');
  const language = pick('language');
  settings.language = language === 'en' || language === 'zh_CN' ? language : null;
  return settings;
}

/* ------------------------------------------------------------------ */
/* Load and save                                                       */
/* ------------------------------------------------------------------ */

async function readSync(storage: StorageLike): Promise<Record<string, any>> {
  try {
    return await storage.sync.get(null);
  } catch {
    return {}; // Sync can be unavailable, e.g. in a guest profile.
  }
}

/** Loads settings, migrating v2 data and pulling a newer synced profile. */
export async function loadSettings(storage: StorageLike): Promise<Settings> {
  const local = await storage.local.get(null);
  const sync = await readSync(storage);

  let settings: Settings | undefined = local[SETTINGS_KEY];
  if (!settings) {
    settings = migrateLegacy(local, sync) ?? defaultSettings();
    await storage.local.set({ [SETTINGS_KEY]: settings });
    await storage.local.remove(LEGACY_KEYS);
    await storage.sync.remove(LEGACY_KEYS).catch(() => {});
    if (settings.profile) await pushProfile(storage, settings);
  }

  if ((sync[SYNC_PROFILE_TS_KEY] ?? 0) > settings.profileUpdatedAt) {
    settings = {
      ...settings,
      profile: sync[SYNC_PROFILE_KEY] ?? settings.profile,
      profileUpdatedAt: sync[SYNC_PROFILE_TS_KEY],
    };
    await storage.local.set({ [SETTINGS_KEY]: settings });
  }
  return settings;
}

export type ProfileSync = 'synced' | 'too-large' | 'unavailable';

async function pushProfile(storage: StorageLike, settings: Settings): Promise<ProfileSync> {
  const size = new TextEncoder().encode(JSON.stringify(settings.profile)).length;
  if (size + SYNC_PROFILE_KEY.length > SYNC_ITEM_LIMIT_BYTES) return 'too-large';
  try {
    await storage.sync.set({
      [SYNC_PROFILE_KEY]: settings.profile,
      [SYNC_PROFILE_TS_KEY]: settings.profileUpdatedAt,
    });
    return 'synced';
  } catch {
    return 'unavailable';
  }
}

let pendingWrite: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write over one stored object, so writes must not interleave:
 * editing the key and then switching provider fires two saves in a row, and
 * the second would otherwise overwrite the first with stale data.
 */
export function saveSettings(
  storage: StorageLike,
  patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)
): Promise<Settings> {
  const write = pendingWrite.then(async () => {
    const current = await loadSettings(storage);
    const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
    await storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
  pendingWrite = write.catch(() => {});
  return write;
}

export async function saveProfile(
  storage: StorageLike,
  profile: string,
  now = Date.now()
): Promise<ProfileSync> {
  const next = await saveSettings(storage, { profile, profileUpdatedAt: now });
  return pushProfile(storage, next);
}

/** The API key and effective model for the selected provider. */
export function activeProvider(settings: Settings): { id: ProviderId; apiKey: string; model: string } {
  const id = settings.provider;
  const config = settings.providers[id];
  return {
    id,
    apiKey: config?.apiKey ?? '',
    model: config?.model || PROVIDERS[id].defaultModel,
  };
}
