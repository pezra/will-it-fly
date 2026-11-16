import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { ModelName } from "../core/scoring/hourEvaluator";
import type { SiteKind } from "../core/sites/site";
import type { DayKey } from "../core/time";
import { DayPicker } from "./DayPicker";
import { dayLabel } from "./format";

/**
 * The list's heading: the day on screen, as a button that opens a drawer with the day picker.
 * `shownDay` is that day and `today` anchors its label. `children` sit at the right of the
 * heading (Refresh). The drawer starts closed, and picking a day or any change of `shownDay` closes
 * it: the open state remembers which day it was opened for, so no effect is needed. The drawer stays
 * in the DOM, hidden, so `aria-controls` always points at it.
 */
export function DayTitle({
  shownDay,
  today,
  model,
  mode,
  children,
}: {
  shownDay: DayKey;
  today: DayKey;
  model: ModelName;
  mode: SiteKind;
  children?: ComponentChildren;
}) {
  const [openFor, setOpenFor] = useState<DayKey | undefined>(undefined);
  const open = openFor === shownDay;
  return (
    <div class="day-title">
      <header class="list-header">
        <h1>
          <button
            type="button"
            class="day-toggle"
            aria-expanded={open}
            aria-controls="day-drawer"
            onClick={() => setOpenFor(open ? undefined : shownDay)}
          >
            {dayLabel(shownDay, today)} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
          </button>
        </h1>
        {children}
      </header>
      {/* A tap on a day link closes it even when the day doesn't change (Today on the default day). */}
      <div
        id="day-drawer"
        class="day-drawer"
        hidden={!open}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a") !== null) setOpenFor(undefined);
        }}
      >
        <DayPicker today={today} shown={shownDay} model={model} mode={mode} />
      </div>
    </div>
  );
}
