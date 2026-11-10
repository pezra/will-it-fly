import { MAX_DAYS_AHEAD } from "../core/recommendation/recommendationService";
import type { ModelName } from "../core/scoring/hourEvaluator";
import { addDays } from "../core/time";
import type { DayKey } from "../core/time";
import { listHref } from "./route";

/**
 * Today and Tomorrow links, plus a date input for any day up to `MAX_DAYS_AHEAD` days out. `shown`
 * is the day on screen (undefined while the default day is still loading). The links keep `model`.
 */
export function DayPicker({
  today,
  shown,
  model,
}: {
  today: DayKey;
  shown: DayKey | undefined;
  model: ModelName;
}) {
  const tomorrow = addDays(today, 1);
  const link = (day: DayKey, label: string) => (
    <a class="day-link" href={listHref(model, day)} aria-current={shown === day ? "page" : undefined}>
      {label}
    </a>
  );
  return (
    <nav class="day-picker" aria-label="Day">
      {link(today, "Today")}
      {link(tomorrow, "Tomorrow")}
      <input
        type="date"
        aria-label="Pick a day"
        min={today}
        max={addDays(today, MAX_DAYS_AHEAD)}
        value={shown ?? ""}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value !== "") window.location.hash = listHref(model, value);
        }}
      />
    </nav>
  );
}
