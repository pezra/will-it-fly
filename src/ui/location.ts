import type { Coordinate } from "../core/sites/site";

export type LocationStatus = "pending" | "found" | "denied" | "unavailable";

export interface LocationResult {
  status: Exclude<LocationStatus, "pending">;
  coordinate?: Coordinate;
}

export const LOCATION_TIMEOUT_MS = 10_000;
const MAX_AGE_MS = 10 * 60_000;

/** One-shot geolocation. Never rejects: any failure resolves with `denied` or `unavailable`. */
export function requestLocation(): Promise<LocationResult> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      resolve({ status: "unavailable" });
      return;
    }
    try {
      navigator.geolocation.getCurrentPosition(
        (position) =>
          resolve({
            status: "found",
            coordinate: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
            },
          }),
        (error) =>
          resolve({ status: error.code === error.PERMISSION_DENIED ? "denied" : "unavailable" }),
        { timeout: LOCATION_TIMEOUT_MS, maximumAge: MAX_AGE_MS, enableHighAccuracy: false },
      );
    } catch (error) {
      console.warn("Geolocation failed", error);
      resolve({ status: "unavailable" });
    }
  });
}
