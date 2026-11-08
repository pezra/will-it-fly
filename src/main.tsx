import { render } from "preact";
import { denverDayKey } from "./core/time";

function App() {
  return <p>Flyable sites: {denverDayKey(Date.now())}</p>;
}

render(<App />, document.getElementById("app")!);
