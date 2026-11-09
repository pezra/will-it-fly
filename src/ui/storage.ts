import type { RemovableStore } from "../core/keyValueStore";

/**
 * A `RemovableStore` over `localStorage`. A blocked or full store never throws out of `get`, which
 * reads as "nothing cached"; `set` and `remove` throw so the cache can log it and carry on.
 */
export function localStorageStore(): RemovableStore {
  return {
    get(key) {
      try {
        return window.localStorage.getItem(key) ?? undefined;
      } catch (error) {
        console.warn("localStorage is unavailable", error);
        return undefined;
      }
    },
    set(key, value) {
      window.localStorage.setItem(key, value);
    },
    remove(key) {
      window.localStorage.removeItem(key);
    },
  };
}
