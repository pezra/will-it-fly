import type { ModelHour } from "../core/forecast/models";
import type { LaunchEvaluation } from "../core/recommendation/types";
import { cloudBaseAboveLaunchM, thermalIndex } from "../core/scoring/derived";
import type { HourResult } from "../core/scoring/hourEvaluator";
import { elevationM } from "../core/sites/site";
import { formatDenverTime } from "../core/time";
import { CallBadge } from "./CallBadge";
import { approxFeet, compass, oneDecimal, whole } from "./format";

function byTime<T extends { time: number }>(items: readonly T[]): Map<number, T> {
  return new Map(items.map((i) => [i.time, i] as const));
}

/** "12 g18 W" style cell pieces. */
function windCell(hour: ModelHour | undefined, withGust: boolean): string {
  if (hour === undefined || hour.windMph === undefined) return "n/a";
  const gust = withGust && hour.gustMph !== undefined ? ` g${Math.round(hour.gustMph)}` : "";
  const dir = hour.windDir === undefined ? "" : ` ${compass(hour.windDir)} ${Math.round(hour.windDir)}°`;
  return `${Math.round(hour.windMph)}${gust}${dir}`;
}

function timeLabel(ms: number): string {
  return formatDenverTime(ms);
}

function ReasonList({ result, label }: { result: HourResult; label: string }) {
  return (
    <li>
      <strong>{label}</strong> <CallBadge call={result.call} />
      {result.reasons.length === 0 ? (
        result.call === "noData" ? (
          <span> no ECMWF data for this hour</span>
        ) : null
      ) : (
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

  const ecmwfHours = byTime(evaluation.ecmwfHours);
  const rrfsHours = byTime(evaluation.rrfsHours);
  const rrfsResults = byTime(evaluation.rrfs);
  const launchM = elevationM(launch);

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
            {daylight.map((result) => {
              const e = ecmwfHours.get(result.time);
              const r = rrfsHours.get(result.time);
              const rr = rrfsResults.get(result.time);
              return (
                <tr key={result.time} class={result.call === "noData" ? "no-data" : undefined}>
                  <th scope="row">{timeLabel(result.time)}</th>
                  <td><CallBadge call={result.call} /></td>
                  <td>{result.call === "noData" ? "no data" : windCell(e, true)}</td>
                  <td>{rr === undefined ? "n/a" : <CallBadge call={rr.call} />}</td>
                  <td>{windCell(r, false)}</td>
                  <td>{whole(e?.capeJkg)}</td>
                  <td>{e === undefined ? "n/a" : approxFeet(cloudBaseAboveLaunchM(e))}</td>
                  <td>{e === undefined ? "n/a" : oneDecimal(thermalIndex(e, launchM))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p class="note">Cloud base is above launch, from temperature minus dewpoint. It runs high at launches well above model terrain.</p>
      <h4>Why, hour by hour</h4>
      <ul class="reasons">
        {daylight.map((result) => (
          <ReasonList key={result.time} result={result} label={timeLabel(result.time)} />
        ))}
      </ul>
    </>
  );
}
