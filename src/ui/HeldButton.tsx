import { useEffect, useState } from "preact/hooks";
import { heldLabel, isHeld } from "./format";

/** A button that is disabled, with a countdown in its label, until `retryAt` (`performance.now()`). */
export function HeldButton({ label, retryAt, onClick, disabled }: {
  label: string;
  retryAt: number | undefined;
  onClick: () => void;
  disabled?: boolean;
}) {
  const [, setTick] = useState(0);
  // Read once, so the disabled state and the label agree at the end of the hold.
  const at = performance.now();
  const held = isHeld(retryAt, at);
  // Its own 1 s interval: the hook's minute tick is too slow for a countdown in seconds.
  useEffect(() => {
    if (!held) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [held]);
  return <button type="button" onClick={onClick} disabled={disabled || held}>{heldLabel(label, retryAt, at)}</button>;
}
