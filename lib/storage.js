/**
 * StorageManager - Unified chrome.storage abstraction.
 *
 * Reads from both local and sync storage and merges results
 * (sync wins, or the most-recent timestamped value wins).
 * Writes go to both stores so every device stays in sync.
 */
const StorageManager = (() => {
  /**
   * Read keys from storage.  For keys that have a corresponding
   * `<key>_ts` timestamp, the store with the newer timestamp wins.
   * For all other keys, sync value takes precedence over local.
   *
   * @param {string|string[]} keys
   * @returns {Promise<Object>}
   */
  async function get(keys) {
    const keyArray = Array.isArray(keys) ? keys : [keys];
    return new Promise((resolve) => {
      chrome.storage.local.get(keyArray, (localResult) => {
        chrome.storage.sync.get(keyArray, (syncResult) => {
          const merged = {};
          for (const key of keyArray) {
            const tsKey = key + '_ts';
            const localTs = localResult[tsKey];
            const syncTs = syncResult[tsKey];
            if (localTs !== undefined || syncTs !== undefined) {
              // Timestamp-based resolution
              merged[key] =
                (syncTs || 0) > (localTs || 0)
                  ? syncResult[key] !== undefined
                    ? syncResult[key]
                    : localResult[key]
                  : localResult[key] !== undefined
                    ? localResult[key]
                    : syncResult[key];
            } else {
              merged[key] =
                syncResult[key] !== undefined
                  ? syncResult[key]
                  : localResult[key];
            }
          }
          resolve(merged);
        });
      });
    });
  }

  /**
   * Write data to both local and sync storage.
   * @param {Object} data
   * @returns {Promise<void>}
   */
  async function set(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, () => {
        chrome.storage.sync.set(data, resolve);
      });
    });
  }

  /**
   * Remove keys from both local and sync storage.
   * @param {string|string[]} keys
   * @returns {Promise<void>}
   */
  async function remove(keys) {
    const keyArray = Array.isArray(keys) ? keys : [keys];
    return new Promise((resolve) => {
      chrome.storage.local.remove(keyArray, () => {
        chrome.storage.sync.remove(keyArray, resolve);
      });
    });
  }

  return { get, set, remove };
})();
