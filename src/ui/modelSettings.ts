import type { KeyValueStore } from "../core/keyValueStore";
import { isModelName } from "../core/scoring/hourEvaluator";
import type { ModelName } from "../core/scoring/hourEvaluator";
import { routeHref } from "./route";
import type { Route } from "./route";

/** The `localStorage` key the saved default model is stored under. */
export const MODEL_SETTINGS_KEY = "willItFly.model.v1";
/** The model used when nothing valid is saved. */
const DEFAULT_MODEL: ModelName = "ecmwf";

/**
 * The saved default model, the one a URL with no model gets. It is ECMWF when nothing valid is
 * saved. Never throws.
 */
export function loadDefaultModel(store: KeyValueStore): ModelName {
  try {
    const text = store.get(MODEL_SETTINGS_KEY);
    if (text === undefined) return DEFAULT_MODEL;
    const value: unknown = JSON.parse(text);
    return isModelName(value) ? value : DEFAULT_MODEL;
  } catch (error) {
    console.warn("Could not read the default model", error);
    return DEFAULT_MODEL;
  }
}

/** Stores the default model. A failed write is logged, not thrown. */
export function saveDefaultModel(store: KeyValueStore, model: ModelName): void {
  try {
    store.set(MODEL_SETTINGS_KEY, JSON.stringify(model));
  } catch (error) {
    console.warn("Could not save the default model", error);
  }
}

/**
 * Makes `model` the saved default and returns the hash of `route` with that model. The model
 * control is the only thing that writes the default; opening a link with a model never does.
 */
export function switchModel(store: KeyValueStore, route: Route, model: ModelName): string {
  saveDefaultModel(store, model);
  return routeHref(route, model);
}
