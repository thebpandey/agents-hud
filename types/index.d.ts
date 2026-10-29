export type HudActivity = 'idle' | 'thinking' | 'generating' | 'tool'

export type HudAgent = {
  id: string
  name: string
  description: string
  type: string
  status: string
  activity: HudActivity
  tool?: string
  model?: string
  ctxTokens?: number
  tools: number
  startedAt: number
  updatedAt: number
  /** The spawn prompt's start and cwd, matched against lane worktrees. */
  hint: string
  /** When the engine stopped listing it; absent while it is listed. */
  unlistedAt?: number
}

export type HudMain = {
  activity: HudActivity
  tool?: string
  working: boolean
  turnStartedAt: number
  tools: number
}

export type HudLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type HudUsage = {
  ctxTokens?: number
  ctxWindow: number
  ctxPercent?: number
  limits: HudLimit[]
  model?: string
}

export type HudCategory = { name: string; tokens: number }

/** What fills the context window, as /context breaks it down. */
export type HudBreakdown = { categories: HudCategory[]; autoCompactAt?: number; isAutoCompact: boolean }

export type HudLane = { lane: string; agent: string; task: string; worktree: string; relay: string }

export type HudLanes = { repo?: string; dir?: string; rows: HudLane[] }

export type HudPlacement = 'panel' | 'band'

export type HudMode = 'auto' | 'agents' | 'lanes'

/** A background relay job of the lanes skill (model-relay, codex-lane, codex-review). */
export type HudJob = {
  id: string
  kind: 'relay' | 'codex' | 'review'
  engine: string
  model: string
  effort: string
  cwd: string
  lane: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number
  endedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agents-hud': {
      agents: HudAgent[]
      main: HudMain
      usage: HudUsage | null
      lanes: HudLanes
      jobs: HudJob[]
      lanesInvoked: boolean
      mode: HudMode
      now: number
      /** Body rows scrolled past while the cards outgrow the panel. */
      skip: number
      /** The band above the prompt shows the context breakdown and plan pace. */
      expanded: boolean
      breakdown: HudBreakdown | null
      /** Index into THEMES; also kept in the store for new sessions. */
      theme: number
      /** The avatar style's name, a key of AVATARS; also kept in the store. */
      avatars: string
      /** Where the usage figures and their settings show. */
      placement: HudPlacement
      /** Lanes with nothing in this session are listed, not folded into one row. */
      showIdle: boolean
      /** The avatars' animation frame, advanced while something works. */
      frame: number
      /** Whether avatars move at all; kept in the store. */
      motion: boolean
    }
  }
}
