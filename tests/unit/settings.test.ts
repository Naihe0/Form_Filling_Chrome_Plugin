import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  activeProvider,
  defaultSettings,
  loadSettings,
  migrateLegacy,
  saveProfile,
  saveSettings,
  type StorageAreaLike,
  type StorageLike,
} from '../../src/shared/settings.ts';

function fakeArea(initial: Record<string, any> = {}, options: { failSet?: boolean } = {}) {
  const data: Record<string, any> = { ...initial };
  const area: StorageAreaLike & { data: Record<string, any> } = {
    data,
    async get(keys) {
      if (keys === null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    async set(items) {
      if (options.failSet) throw new Error('sync unavailable');
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
  return area;
}

function fakeStorage(local = {}, sync = {}, options = {}) {
  return { local: fakeArea(local), sync: fakeArea(sync, options) } satisfies StorageLike;
}

const legacy = {
  userProfile: JSON.stringify(['Ada Lovelace', 'Lives in London']),
  userProfile_ts: 100,
  selectedProvider: 'gemini',
  providerConfigs: { gemini: { apiKey: 'SECRET', modelId: 'gemini-x' } },
  quick_query_enabled: true,
  correction_enabled: true,
  isFilling: true,
  language: 'zh_CN',
};

describe('migrateLegacy', () => {
  it('returns null when there is no v2 data', () => {
    assert.equal(migrateLegacy({}, {}), null);
  });

  it('converts every v2 setting', () => {
    const settings = migrateLegacy(legacy, {});
    assert.ok(settings);
    assert.equal(settings.profile, 'Ada Lovelace\n---\nLives in London');
    assert.equal(settings.profileUpdatedAt, 100);
    assert.equal(settings.provider, 'gemini');
    assert.deepEqual(settings.providers.gemini, { apiKey: 'SECRET', model: 'gemini-x' });
    assert.equal(settings.quickQuery, true);
    assert.equal(settings.language, 'zh_CN');
  });

  it('keeps a raw-text profile', () => {
    assert.equal(migrateLegacy({ userProfile: 'plain text' }, {})?.profile, 'plain text');
  });

  it('prefers the newer profile by timestamp', () => {
    const settings = migrateLegacy(
      { userProfile: 'old', userProfile_ts: 1 },
      { userProfile: 'new', userProfile_ts: 2 }
    );
    assert.equal(settings?.profile, 'new');
  });

  it('survives an unknown provider and defaults to v2 behaviour', () => {
    const settings = migrateLegacy({ selectedProvider: 'deepseek', providerConfigs: { deepseek: {} } }, {});
    assert.equal(settings?.provider, 'openai');
    assert.deepEqual(settings?.providers, {});
  });
});

describe('loadSettings', () => {
  it('returns defaults on a fresh install', async () => {
    const settings = await loadSettings(fakeStorage());
    assert.deepEqual(settings, defaultSettings());
  });

  it('removes API keys from sync when migrating', async () => {
    const storage = fakeStorage(legacy, legacy);
    const settings = await loadSettings(storage);

    assert.equal(settings.providers.gemini?.apiKey, 'SECRET');
    assert.ok(!JSON.stringify(storage.sync.data).includes('SECRET'));
    assert.ok(!('providerConfigs' in storage.local.data));
    assert.ok(!('userProfile' in storage.local.data));
    assert.equal(storage.sync.data.profile, settings.profile);
  });

  it('migrates only once', async () => {
    const storage = fakeStorage(legacy);
    await loadSettings(storage);
    await saveSettings(storage, { provider: 'openai' });
    storage.local.data.providerConfigs = { gemini: { apiKey: 'STALE' } };

    const settings = await loadSettings(storage);

    assert.equal(settings.provider, 'openai');
    assert.equal(settings.providers.gemini?.apiKey, 'SECRET');
  });

  it('adopts a newer profile synced from another device', async () => {
    const storage = fakeStorage();
    await saveProfile(storage, 'mine', 100);
    storage.sync.data.profile = 'from laptop';
    storage.sync.data.profileUpdatedAt = 200;

    const settings = await loadSettings(storage);

    assert.equal(settings.profile, 'from laptop');
    assert.equal(settings.profileUpdatedAt, 200);
  });

  it('ignores an older synced profile', async () => {
    const storage = fakeStorage();
    await saveProfile(storage, 'mine', 300);
    storage.sync.data.profile = 'stale';
    storage.sync.data.profileUpdatedAt = 200;
    assert.equal((await loadSettings(storage)).profile, 'mine');
  });
});

describe('saveSettings', () => {
  it('does not lose a write when two are made in a row', async () => {
    const storage = fakeStorage();
    await Promise.all([
      saveSettings(storage, { overwrite: true }),
      saveSettings(storage, { provider: 'openai' }),
      saveSettings(storage, { quickQuery: true }),
    ]);
    const settings = await loadSettings(storage);
    assert.equal(settings.overwrite, true);
    assert.equal(settings.provider, 'openai');
    assert.equal(settings.quickQuery, true);
  });

  it('keeps working after a failed write', async () => {
    const storage = fakeStorage();
    const { set } = storage.local;
    storage.local.set = async () => {
      throw new Error('quota');
    };
    await assert.rejects(saveSettings(storage, { overwrite: true }));
    storage.local.set = set;
    assert.equal((await saveSettings(storage, { quickQuery: true })).quickQuery, true);
  });
});

describe('saveProfile', () => {
  it('syncs a normal profile but never the API key', async () => {
    const storage = fakeStorage();
    await saveSettings(storage, { providers: { gemini: { apiKey: 'SECRET', model: '' } } });

    assert.equal(await saveProfile(storage, 'Ada'), 'synced');

    assert.equal(storage.sync.data.profile, 'Ada');
    assert.ok(!JSON.stringify(storage.sync.data).includes('SECRET'));
  });

  it('keeps an oversized profile on this device and says so', async () => {
    const storage = fakeStorage();
    const huge = '字'.repeat(4000);

    assert.equal(await saveProfile(storage, huge), 'too-large');

    assert.equal(storage.sync.data.profile, undefined);
    assert.equal((await loadSettings(storage)).profile, huge);
  });

  it('survives sync being unavailable', async () => {
    const storage = fakeStorage({}, {}, { failSet: true });
    assert.equal(await saveProfile(storage, 'Ada'), 'unavailable');
    assert.equal((await loadSettings(storage)).profile, 'Ada');
  });
});

describe('activeProvider', () => {
  it('falls back to the default model when none is set', () => {
    const settings = { ...defaultSettings(), provider: 'gemini' as const };
    assert.deepEqual(activeProvider(settings), { id: 'gemini', apiKey: '', model: 'gemini-flash-latest' });
  });

  it('uses the configured model and key', () => {
    const settings = {
      ...defaultSettings(),
      providers: { gemini: { apiKey: 'k', model: 'gemini-3.8-flash' } },
    };
    assert.deepEqual(activeProvider(settings), { id: 'gemini', apiKey: 'k', model: 'gemini-3.8-flash' });
  });
});
