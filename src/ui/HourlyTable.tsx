import type { ModelHour } from "../core/forecast/models";
import type { DaylightRow, LaunchEvaluation } from "../core/recommendation/types";
import type { HourResult } from "../core/scoring/hourEvaluator";
import { formatDenverTime } from "../core/time";
import type { SiteKind } from "../core/sites/site";
import { compass } from "../core/units";
import { ResultBadge } from "./CallBadge";
import { approxFeet, hourlyColumns, oneDecimal, whole } from "./format";
import type { HourlyColumn } from "./format";

/** Launch-height wind this far from the model's 10 m wind (mph) gets a marker. */
const LAUNCH_WIND_MARK_MPH = 1;

/**
 * "12 g18 W 270°": the wind the call was scored on (launch height), with the hour's gust. A "†"
 * marks a launch wind that differs from the 10 m wind by a mile per hour or more.
 */
/** True when the launch wind differs from the model's 10 m wind by at least the marker threshold. */
function isMarked(result: HourResult | undefined, hour: ModelHour | undefined): boolean {
  const wind = result?.launchWind;
  return (
    wind !== undefined &&
    hour?.windMph !== undefined &&
    Math.abs(wind.speedMph - hour.windMph) >= LAUNCH_WIND_MARK_MPH
  );
}

function WindCell({
  result,
  hour,
  withGust,
}: {
  result: HourResult | undefined;
  hour: ModelHour | undefined;
  withGust: boolean;
}) {
  const wind = result?.launchWind;
  if (wind === undefined) return <>n/a</>;
  const gust = withGust && hour?.gustMph !== undefined ? ` g${Math.round(hour.gustMph)}` : "";
  const text = `${Math.round(wind.speedMph)}${gust} ${compass(wind.dirDeg)} ${Math.round(wind.dirDeg)}°`;
  if (!isMarked(result, hour) || hour?.windMph === undefined) return <>{text}</>;
  return (
    <span title={`Launch-height wind; the model's 10 m wind is ${Math.round(hour.windMph)} mph`}>
      {text}†
    </span>
  );
}

function ReasonList({ result, label }: { result: HourResult; label: string }) {
  return (
    <li>
      <strong>{label}</strong> <ResultBadge call={result.call} conditions={result.conditions} />
      {result.reasons.length > 0 && (
        <ul>
          {result.reasons.map((r) => (
            <li key={r.kind} class={`reason reason-${r.severity}`}>
              {r.text}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** One body cell: the column's value from the primary or check side of the row. */
function Cell({ column, row }: { column: HourlyColumn; row: DaylightRow }) {
  const side = column.side === "check" ? row.check : row.primary;
  switch (column.value) {
    case "time":
      return <th scope="row">{formatDenverTime(row.time)}</th>;
    case "call":
      return (
        <td>
          {side === undefined ? "n/a" : <ResultBadge call={side.result.call} conditions={side.result.conditions} />}
        </td>
      );
    case "wind":
      return (
        <td>
          {column.side === "primary" && side?.result.call === "noData" ? (
            "no data"
          ) : (
            <WindCell result={side?.result} hour={side?.hour} withGust={column.withGust === true} />
          )}
        </td>
      );
    case "cape":
      return <td>{whole(side?.hour.capeJkg)}</td>;
    case "cloudBase":
      return <td>{approxFeet(side?.result.cloudBaseM)}</td>;
    case "thermalIndex":
      return <td>{oneDecimal(side?.result.thermalIndexC)}</td>;
  }
}

/**
 * One launch's daylight hours, the primary model's columns first and the check model's after
 * them, both named from the launch's model. Scrolls sideways on a phone with the time column
 * pinned. Reasons for each hour follow the table.
 */
export function HourlyTable({ evaluation, kind }: { evaluation: LaunchEvaluation; kind: SiteKind }) {
  const { launch, daylight, model } = evaluation;
  const columns = hourlyColumns(model, kind);
  if (daylight.length === 0) return <p class="note">No daylight hours left in this forecast.</p>;

  return (
    <>
      <div class="table-wrap" tabIndex={0} role="region" aria-label={`${launch.name} hourly conditions`}>
        <table class="hourly">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.header} scope="col">{column.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {daylight.map((row) => (
              <tr key={row.time} class={row.primary.result.call === "noData" ? "no-data" : undefined}>
                {columns.map((column) => (
                  <Cell key={column.header} column={column} row={row} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {daylight.some((row) =>
          (row.primary.result.call !== "noData" && isMarked(row.primary.result, row.primary.hour)) ||
          isMarked(row.check?.result, row.check?.hour)) && (
        <p class="note">† launch-height wind (interpolated from pressure levels)</p>
      )}
      {columns.some((column) => column.value === "cloudBase") && (
        <p class="note">Cloud base is above launch, from temperature minus dewpoint. It runs high at launches well above model terrain.</p>
      )}
      <h4>Why, hour by hour</h4>
      <ul class="reasons">
        {daylight.map(({ time, primary }) => (
          <ReasonList key={time} result={primary.result} label={formatDenverTime(time)} />
        ))}
      </ul>
    </>
  );
}
