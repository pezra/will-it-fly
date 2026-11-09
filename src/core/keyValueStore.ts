/** The slice of `localStorage` the caches need. `get` returns undefined for a missing key. */
export interface KeyValueStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/** A `KeyValueStore` that can also delete a key. */
export interface RemovableStore extends KeyValueStore {
  remove(key: string): void;
}
