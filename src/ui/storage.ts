import type { KeyValueStore } from "../core/forecast/forecastCache";

/**
 * A `KeyValueStore` over `localStorage`. A blocked or full store never throws out of `get`, which
 * reads as "nothing cached"; `set` throws so the cache can log it and carry on.
 */
export function localStorageStore(): KeyValueStore {
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
  };
}
