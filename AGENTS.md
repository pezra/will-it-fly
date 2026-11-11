# Agents

Read `CONTRIBUTING.md` for the layout, how the app loads and scores, and the site data format. Read `decisions.md` before changing anything architectural.

## Before calling a change done

Use Node 24 (`nvm use`). All of these must pass:

```sh
npm test
TZ=UTC npm test
TZ=Asia/Kolkata npm test
npm run check
```

## Rules

- `src/core` has no DOM or browser globals and imports nothing from `preact` or `src/ui`. It reaches the outside world only through the `Transport`, `KeyValueStore` and `now` it's given.
- Times in `src/core` are epoch milliseconds. Calendar logic goes through `src/core/time.ts`, and nothing uses `Date`'s local-time getters.
- A change to `SCORING_DEFAULTS` or to a scoring rule updates the "How sites are scored" section of `README.md` in the same commit.
- Tests read fixtures with Vite's `?raw` import, not `node:fs`. Open-Meteo fixtures are re-recorded with the commands in `CONTRIBUTING.md`, never edited by hand.
- `README.md` describes the app as it is now: usage, and how it decides which sites are flyable. No history or plans, except safety caveats.
- No training hills or tow sites as flying sites in `sites.json`. Parks for ground handling go in as `"kind": "kiting"` sites. Adding sites follows the `add-sites` skill, `.agents/skills/add-sites/SKILL.md`.
- A decision that would be costly to reverse gets an entry in `decisions.md`, as described in `CONTRIBUTING.md`.
