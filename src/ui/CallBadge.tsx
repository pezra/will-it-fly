import type { HourCall } from "../core/scoring/hourEvaluator";
import { callGlyph, callLabel } from "./format";

export type BadgeCall = HourCall | "closed";

/** A call as colored text plus a glyph and a word, so color is never the only signal. */
export function CallBadge({ call }: { call: BadgeCall }) {
  const label = call === "closed" ? "Closed" : callLabel(call);
  const glyph = call === "closed" ? "⛔" : callGlyph(call);
  return (
    <span class={`badge badge-${call}`}>
      <span aria-hidden="true">{glyph}</span> {label}
    </span>
  );
}
