import type { ModelName } from "../core/scoring/hourEvaluator";
import { SITE_KINDS } from "../core/sites/site";
import type { SiteKind } from "../core/sites/site";
import type { DayKey } from "../core/time";
import { listHref } from "./route";

const MODE_LABEL: Readonly<Record<SiteKind, string>> = { flying: "Fly", kiting: "Kite" };

/** Links to the same day and model in each mode. The mode on screen is the current page. */
export function ModeToggle({ mode, day, model }: { mode: SiteKind; day: DayKey | undefined; model: ModelName }) {
  return (
    <nav class="mode-toggle" aria-label="Mode">
      {SITE_KINDS.map((kind) => (
        <a
          key={kind}
          class="mode-link"
          href={listHref(model, kind, day)}
          aria-current={kind === mode ? "page" : undefined}
        >
          {MODE_LABEL[kind]}
        </a>
      ))}
    </nav>
  );
}
