import { render } from "preact";
import { App } from "./ui/App";
import { currentDebugParams } from "./ui/debugParams";
import "./ui/styles.css";

const debug = currentDebugParams();
render(<App debug={debug} />, document.getElementById("app")!);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .catch((error: unknown) => console.warn("Service worker registration failed", error));
  });
}
