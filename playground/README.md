# Visualization layer

Install its isolated dependencies once with `cd playground && bun install --frozen-lockfile`.

Run from the repository root with `bun run browser`. Typecheck this layer with
`bun run browser:typecheck`; the original `bun run typecheck` checks the core.

- `app.ts` imports the public `createOrderService` API and provides simulated
  payment/fulfillment dependencies. It renders returned snapshots and results.
- `scene.ts` projects snapshots into a Three.js graph with clickable destination buttons,
  highlighted paths, and a moving order marker. It invokes callbacks supplied by the playground controller; it never changes domain state.
- `index.html` owns presentation only.
- `server.ts` serves the page and bundles TypeScript for the browser using Bun.
- `tsconfig.json` keeps browser DOM types out of the core configuration.

The dependency direction is `playground → index.ts`. The core does not know the
playground exists. No callbacks, UI state, delays, or scenario logic have been
added to the state machine. The only core-file adjustment is an
`import.meta.main` guard around the original executable example to prevent
side effects on import. `bun index.ts` still runs that example.

The UI presents only choices relevant to the current step. A fulfillment failure
starts the real recovery operation, whose stubbed void promise waits for the user
to choose success or failure. While it waits, the original order correctly remains
`payment_authorized`; no invented recovery state is added to its history.

The camera stays fixed so action targets do not move. Reduced-motion preferences
disable transition animations. If WebGL is unavailable, ordinary action buttons
replace the graph. Core concurrency guards remain covered by the original tests.
