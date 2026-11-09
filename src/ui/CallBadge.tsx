import { Fragment } from "preact";
import type { HourCall, HourCondition } from "../core/scoring/hourEvaluator";
import { CONDITION_LABEL, callDisplay, callGlyph, callLabel } from "./format";

type BadgeCall = "noGo" | "noData" | "closed";

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

/** Condition pills for a good or flyable result, or the call's badge otherwise. */
export function ResultBadge({
  call,
  conditions,
}: {
  call: HourCall | "closed";
  conditions: readonly HourCondition[] | undefined;
}) {
  const display = callDisplay(call, conditions);
  if (display.kind === "badge") return <CallBadge call={display.call} />;
  return (
    <span>
      {display.conditions.map((c, i) => (
        <Fragment key={c}>
          {i > 0 && " "}
          <span class={`badge badge-${c}`}>{CONDITION_LABEL[c]}</span>
        </Fragment>
      ))}
    </span>
  );
}
