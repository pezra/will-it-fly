import type { DegreeArc } from "./site";

/** Normalizes any angle into [0, 360). */
export function normalizedDegrees(degrees: number): number {
  const r = degrees % 360;
  return r < 0 ? r + 360 : r;
}

/** Shortest angular distance between two bearings, 0 to 180. */
export function angularDifference(a: number, b: number): number {
  const d = Math.abs(normalizedDegrees(a) - normalizedDegrees(b));
  return d > 180 ? 360 - d : d;
}

/** True if `degrees` lies on the arc. Arcs may wrap through north (330 to 30). */
export function arcContains(arc: DegreeArc, degrees: number): boolean {
  if (arc.to - arc.from >= 360) return true;
  const x = normalizedDegrees(degrees);
  const start = normalizedDegrees(arc.from);
  const end = normalizedDegrees(arc.to);
  if (start <= end) return x >= start && x <= end;
  return x >= start || x <= end;
}

/** True if any arc contains `degrees`. */
export function arcsContain(arcs: readonly DegreeArc[], degrees: number): boolean {
  return arcs.some((arc) => arcContains(arc, degrees));
}
