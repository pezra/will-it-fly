import type { ModelHour } from "../core/forecast/models";
import type { LaunchEvaluation } from "../core/recommendation/types";
import type { HourResult } from "../core/scoring/hourEvaluator";
import { formatDenverTime } from "../core/time";
import { compass } from "../core/units";
import { ResultBadge } from "./CallBadge";
import { approxFeet, oneDecimal, whole } from "./format";

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

/**
 * One launch's daylight hours, ECMWF and RRFS side by side. Scrolls sideways on a phone with the
 * time column pinned. Reasons for each hour follow the table.
 */
export function HourlyTable({ evaluation }: { evaluation: LaunchEvaluation }) {
  const { launch, daylight } = evaluation;
  if (daylight.length === 0) return <p class="note">No daylight hours left in this forecast.</p>;

  return (
    <>
      <div class="table-wrap" tabIndex={0} role="region" aria-label={`${launch.name} hourly conditions`}>
        <table class="hourly">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">ECMWF</th>
              <th scope="col">Wind / gust / dir</th>
              <th scope="col">RRFS</th>
              <th scope="col">RRFS wind / dir</th>
              <th scope="col">CAPE J/kg</th>
              <th scope="col">Cloud base</th>
              <th scope="col">TI °C</th>
            </tr>
          </thead>
          <tbody>
            {daylight.map(({ time, primary, check }) => (
              <tr key={time} class={primary.result.call === "noData" ? "no-data" : undefined}>
                <th scope="row">{formatDenverTime(time)}</th>
                <td><ResultBadge call={primary.result.call} conditions={primary.result.conditions} /></td>
                <td>{primary.result.call === "noData" ? "no data" : <WindCell result={primary.result} hour={primary.hour} withGust={true} />}</td>
                <td>{check === undefined ? "n/a" : <ResultBadge call={check.result.call} conditions={check.result.conditions} />}</td>
                <td><WindCell result={check?.result} hour={check?.hour} withGust={false} /></td>
                <td>{whole(primary.hour.capeJkg)}</td>
                <td>{approxFeet(primary.result.cloudBaseM)}</td>
                <td>{oneDecimal(primary.result.thermalIndexC)}</td>
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
      <p class="note">Cloud base is above launch, from temperature minus dewpoint. It runs high at launches well above model terrain.</p>
      <h4>Why, hour by hour</h4>
      <ul class="reasons">
        {daylight.map(({ time, primary }) => (
          <ReasonList key={time} result={primary.result} label={formatDenverTime(time)} />
        ))}
      </ul>
    </>
  );
}
