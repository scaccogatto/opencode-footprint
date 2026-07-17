/** @jsxImportSource @opentui/solid */
// TUI sidebar panel: session eco grade + CO2/kWh on one line, all-time
// (cross-session) totals on a second line. All the math lives in
// co2-tracker.ts / co2-sidebar-logic.ts (plain, unit-tested .ts modules);
// this file only wires reactive reads to those pure functions and renders
// the resulting strings -- no logic of its own.
import { createEffect, createMemo, Show, untrack } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { getGridIntensity, summarizeLifetime, upsertLifetimeSession, type LifetimeSessions } from "./co2-tracker.ts"
import { computeSessionCo2, formatLifetimeLine, formatSessionLine } from "./lib/co2-sidebar-logic.ts"

const KV_KEY = "co2.lifetime.sessions"

function Footer(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current

  const messages = createMemo(() => props.api.state.session.messages(props.sessionID) as any[])
  const session = createMemo(() => computeSessionCo2(messages(), getGridIntensity()))

  // Persist this session's latest running total into kv as a side effect.
  // The stored map is read `untrack`-ed here so the effect doesn't subscribe
  // to the very key it writes -- reading it reactively would re-trigger the
  // effect on its own write, looping forever. Overwriting this session's
  // entry (rather than accumulating a delta) keeps repeated re-renders,
  // reconnects, and TUI restarts from ever double-counting it.
  createEffect(() => {
    if (!props.api.kv.ready) return
    // Don't persist a session before it has any assistant messages -- that
    // would write a {grams:0,kwh:0} entry for every session merely opened,
    // inflating the lifetime session count with sessions that never used
    // any tokens.
    if (session().messages === 0) return
    const stored = untrack(() => props.api.kv.get<LifetimeSessions>(KV_KEY, {}))
    props.api.kv.set(
      KV_KEY,
      upsertLifetimeSession(stored, props.sessionID, {
        grams: session().co2Grams,
        kwh: session().energyKwh,
      }),
    )
  })

  // Display value: reads kv reactively (so it updates when the effect above
  // -- or another session's panel -- persists), merging in this session's
  // current total speculatively so the number doesn't lag a tick behind the
  // effect's own write.
  const lifetime = createMemo(() => {
    const stored = props.api.kv.ready ? props.api.kv.get<LifetimeSessions>(KV_KEY, {}) : {}
    const merged = upsertLifetimeSession(stored, props.sessionID, {
      grams: session().co2Grams,
      kwh: session().energyKwh,
    })
    return summarizeLifetime(merged)
  })

  return (
    <Show when={session().messages > 0}>
      <box flexDirection="column">
        <text fg={theme().text}>{formatSessionLine(session())}</text>
        <text fg={theme().textMuted}>{formatLifetimeLine(lifetime())}</text>
      </box>
    </Show>
  )
}

// `sidebar_footer` is a "single_winner" slot: whichever registered plugin
// sorts first by (order asc, then registration order) is the only one
// rendered -- the host's own `internal:sidebar-footer` (order 100, showing
// the getting-started hint / path / OpenCode version) would otherwise win
// and we'd never render. Use a lower order so this panel wins instead; that
// necessarily replaces the built-in footer content while a session is open.
const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 50,
    slots: {
      sidebar_footer(_ctx, props) {
        return <Footer api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-footprint.co2-sidebar",
  tui,
}

export default plugin
