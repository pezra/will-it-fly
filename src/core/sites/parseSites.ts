import type {
  DegreeArc,
  DirectionRanges,
  Launch,
  Site,
  SiteStatus,
  WindLimits,
} from "./site";

/** Thrown for malformed site data. The message names the record and field path. */
export class SiteDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteDataError";
  }
}

type Obj = Record<string, unknown>;

function fail(where: string, problem: string): never {
  throw new SiteDataError(`${where}: ${problem}`);
}

function obj(v: unknown, where: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(where, "expected an object");
  return v as Obj;
}

function str(o: Obj, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string") fail(`${where}.${key}`, "expected a string");
  return v;
}

function num(o: Obj, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${where}.${key}`, "expected a number");
  return v;
}

function arr(o: Obj, key: string, where: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) fail(`${where}.${key}`, "expected an array");
  return v;
}

/** null counts as absent, like Swift's decodeIfPresent. */
function present(o: Obj, key: string): boolean {
  return o[key] !== undefined && o[key] !== null;
}

function optStr(o: Obj, key: string, where: string): string | undefined {
  return present(o, key) ? str(o, key, where) : undefined;
}

function optNum(o: Obj, key: string, where: string): number | undefined {
  return present(o, key) ? num(o, key, where) : undefined;
}

function parseLimits(v: unknown, where: string): WindLimits {
  const o = obj(v, where);
  const limits: WindLimits = { minMph: num(o, "minMph", where), maxMph: num(o, "maxMph", where) };
  const ideal = optNum(o, "idealMph", where);
  if (ideal !== undefined) limits.idealMph = ideal;
  const gust = optNum(o, "gustFactorMph", where);
  if (gust !== undefined) limits.gustFactorMph = gust;
  return limits;
}

function parseArcs(o: Obj, key: string, where: string): DegreeArc[] {
  return arr(o, key, where).map((a, i) => {
    const w = `${where}.${key}[${i}]`;
    const ao = obj(a, w);
    return { from: num(ao, "from", w), to: num(ao, "to", w) };
  });
}

function parseDirections(v: unknown, where: string): DirectionRanges {
  const o = obj(v, where);
  return { ok: parseArcs(o, "ok", where), ideal: parseArcs(o, "ideal", where) };
}

function parseStatus(v: unknown, where: string): SiteStatus {
  const o = obj(v, where);
  const state = str(o, "state", where);
  if (state === "open") return { state: "open" };
  if (state === "closed") return { state: "closed", reason: optStr(o, "reason", where) ?? "Closed" };
  return fail(`${where}.state`, `unknown site state '${state}'`);
}

function parseLaunch(v: unknown, where: string): Launch {
  const o = obj(v, where);
  const coordWhere = `${where}.coordinate`;
  const c = obj(o["coordinate"], coordWhere);
  const launch: Launch = {
    id: str(o, "id", where),
    name: str(o, "name", where),
    coordinate: { latitude: num(c, "latitude", coordWhere), longitude: num(c, "longitude", coordWhere) },
    elevationFt: num(o, "elevationFt", where),
    directions: parseDirections(o["directions"], `${where}.directions`),
  };
  if (present(o, "limits")) launch.limits = parseLimits(o["limits"], `${where}.limits`);
  return launch;
}

function parseSite(v: unknown, where: string): Site {
  const o = obj(v, where);
  const id = optStr(o, "id", where);
  // Name the record by id once we know it, for clearer messages.
  const w = id === undefined ? where : `${where} (${id})`;
  const site: Site = {
    id: str(o, "id", w),
    name: str(o, "name", w),
    sourceURL: str(o, "sourceURL", w),
    rating: str(o, "rating", w),
    status: parseStatus(o["status"], `${w}.status`),
    launches: arr(o, "launches", w).map((l, i) => parseLaunch(l, `${w}.launches[${i}]`)),
    limits: parseLimits(o["limits"], `${w}.limits`),
  };
  const notes = optStr(o, "notes", w);
  if (notes !== undefined) site.notes = notes;
  return site;
}

/**
 * Validates a `{ curatedOn?, sites }` catalog and returns fresh Site objects.
 * JSON-only fields (elevationSource, limitsSource, directionsSource,
 * landingZones) are dropped. Throws SiteDataError on a malformed record.
 */
export function parseSites(json: unknown): Site[] {
  const top = obj(json, "catalog");
  if (present(top, "curatedOn") && typeof top["curatedOn"] !== "string") {
    fail("catalog.curatedOn", "expected a string");
  }
  return arr(top, "sites", "catalog").map((s, i) => parseSite(s, `sites[${i}]`));
}
