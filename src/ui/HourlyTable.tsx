import type { ModelHour } from "../core/forecast/models";
import type { LaunchEvaluation } from "../core/recommendation/types";
import type { HourResult } from "../core/scoring/hourEvaluator";
import { formatDenverTime } from "../core/time";
import { compass } from "../core/units";
import { CallBadge } from "./CallBadge";
import { approxFeet, oneDecimal, whole } from "./format";

/** "12 g18 W" style cell pieces. */
function windCell(hour: ModelHour | undefined, withGust: boolean): string {
  if (hour === undefined || hour.windMph === undefined) return "n/a";
  const gust = withGust && hour.gustMph !== undefined ? ` g${Math.round(hour.gustMph)}` : "";
  const dir = hour.windDir === undefined ? "" : ` ${compass(hour.windDir)} ${Math.round(hour.windDir)}°`;
  return `${Math.round(hour.windMph)}${gust}${dir}`;
}

function ReasonList({ result, label }: { result: HourResult; label: string }) {
  return (
    <li>
      <strong>{label}</strong> <CallBadge call={result.call} />
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
            {daylight.map(({ time, ecmwf, ecmwfHour, rrfs, rrfsHour }) => (
              <tr key={time} class={ecmwf.call === "noData" ? "no-data" : undefined}>
                <th scope="row">{formatDenverTime(time)}</th>
                <td><CallBadge call={ecmwf.call} /></td>
                <td>{ecmwf.call === "noData" ? "no data" : windCell(ecmwfHour, true)}</td>
                <td>{rrfs === undefined ? "n/a" : <CallBadge call={rrfs.call} />}</td>
                <td>{windCell(rrfsHour, false)}</td>
                <td>{whole(ecmwfHour.capeJkg)}</td>
                <td>{approxFeet(ecmwf.cloudBaseM)}</td>
                <td>{oneDecimal(ecmwf.thermalIndexC)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="note">Cloud base is above launch, from temperature minus dewpoint. It runs high at launches well above model terrain.</p>
      <h4>Why, hour by hour</h4>
      <ul class="reasons">
        {daylight.map(({ time, ecmwf }) => (
          <ReasonList key={time} result={ecmwf} label={formatDenverTime(time)} />
        ))}
      </ul>
    </>
  );
}
