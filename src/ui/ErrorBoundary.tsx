import { Component } from "preact";
import type { ComponentChildren } from "preact";
import { isReporting, reportError } from "./sentry";

/** Replaces a crashed app with a message and a reload button, and reports the crash. */
export class ErrorBoundary extends Component<{ children: ComponentChildren }, { failed: boolean }> {
  state = { failed: false };

  componentDidCatch(error: unknown) {
    console.error("The app crashed", error);
    reportError(error);
    this.setState({ failed: true });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div class="error" role="alert">
        <p>
          <strong>Something went wrong.</strong>
          {isReporting() && navigator.onLine ? " The error has been reported." : ""}
        </p>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
