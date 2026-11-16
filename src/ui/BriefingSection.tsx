import { useEffect, useRef, useState } from "preact/hooks";
import type { Site } from "../core/sites/site";
import type { DayKey } from "../core/time";
import { briefingLinks, briefingPrompt, copyPrompt } from "./briefing";
import type { CopyState } from "./briefing";

const COPY_LABEL: Readonly<Record<CopyState, string>> = {
  idle: "Copy briefing prompt",
  copied: "Copied",
  failed: "Couldn't copy",
};

/**
 * Links that open Claude or ChatGPT with a conditions-briefing prompt for the site and day, and a
 * button that copies the prompt. The button's label returns to idle after two seconds.
 */
export function BriefingSection({ site, day }: { site: Site; day: DayKey }) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const prompt = briefingPrompt(site, day);
  const links = briefingLinks(prompt);

  const onCopy = async () => {
    clearTimeout(timer.current);
    // navigator.clipboard is undefined on plain http.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    setCopy(await copyPrompt(clipboard, prompt));
    timer.current = setTimeout(() => setCopy("idle"), 2000);
  };

  return (
    <section class="briefing">
      <h2>Conditions briefing</h2>
      <p class="note">Ask an AI chat for its own briefing for this site and day. It doesn't see this app's call.</p>
      <p class="briefing-links">
        <a href={links.claude} target="_blank" rel="noopener noreferrer">Brief with Claude</a>
        <a href={links.chatgpt} target="_blank" rel="noopener noreferrer">Brief with ChatGPT</a>
        <button type="button" onClick={onCopy}>{COPY_LABEL[copy]}</button>
      </p>
    </section>
  );
}
