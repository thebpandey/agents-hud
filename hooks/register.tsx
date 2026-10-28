import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, RasterProps, Register, RenderChildren } from 'claude-code'

import type { HudActivity, HudAgent, HudJob, HudLane, HudLanes, HudLimit, HudMain, HudMode, HudUsage } from '../types'

// ── State ────────────────────────────────────────────────────────────────

const agents = atom({ plugin: 'agents-hud', key: 'agents' } as const, [])
const INITIAL_MAIN: HudMain = { activity: 'idle', working: false, turnStartedAt: 0, tools: 0 }
const main = atom({ plugin: 'agents-hud', key: 'main' } as const, INITIAL_MAIN)
const usage = atom({ plugin: 'agents-hud', key: 'usage' } as const, null)
const lanes = atom({ plugin: 'agents-hud', key: 'lanes' } as const, { rows: [] })
const lanesInvoked = atom({ plugin: 'agents-hud', key: 'lanesInvoked' } as const, false)
const INITIAL_MODE: HudMode = 'auto'
const mode = atom({ plugin: 'agents-hud', key: 'mode' } as const, INITIAL_MODE)
const now = atom({ plugin: 'agents-hud', key: 'now' } as const, 0)
const jobs = atom({ plugin: 'agents-hud', key: 'jobs' } as const, [])
const skip = atom({ plugin: 'agents-hud', key: 'skip' } as const, 0)

const PANE = 'agents-hud'
const TITLE = 'Agents'
const TICK_MS = 2000
const KEEP_DONE_MS = 30 * 60_000
const LIVE = new Set(['pending', 'running', 'waiting'])

type Els = ReturnType<EngineInterface['ui']['resolve']>
type View = {
  ag: HudAgent[]
  m: HudMain
  u: HudUsage | null
  l: HudLanes
  jobs: HudJob[]
  isLanes: boolean
  at: number
  raster: boolean
  nick: Map<string, string>
  /** 0 full cards, 1 compact, 2 one line each: chosen so every card fits. */
  density: Density
}

type Density = 0 | 1 | 2
const CARD_ROWS = [4, 2, 1] as const

// ── Formatting ───────────────────────────────────────────────────────────

function prettyModel(id?: string): string {
  if (!id) return '…'
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(id)
  if (!m) return id.replace(/^claude-/, '')
  const fam = m[1]!
  return `${fam[0]!.toUpperCase()}${fam.slice(1).toLowerCase()} ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ''}`
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function fmtTokens(n?: number): string {
  if (n === undefined) return '–'
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function fmtClock(t: number, withDay: boolean): string {
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
  if (withDay) opts.weekday = 'short'
  try {
    return new Date(t).toLocaleString('en-US', opts)
  } catch {
    return new Date(t).toISOString().slice(5, 16).replace('T', ' ')
  }
}

function cut(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`
}

function pctColor(p: number): string {
  return p >= 85 ? 'error' : p >= 60 ? 'warning' : 'success'
}

function barText(pct: number, w: number): [string, string] {
  const f = Math.max(0, Math.min(w, Math.round((pct / 100) * w)))
  return ['━'.repeat(f), '─'.repeat(w - f)]
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function hsl(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)
}

// ── Avatar: a 6×6 pixel robot, two pixels per cell ───────────────────────

const AV_W = 6
const DEFAULT = 0x01000000
const ROBOTS = [
  ['..aa..', '.hhhh.', 'heehhe', 'hhmmhh', '.bbbb.', 'bb..bb'],
  ['a....a', '.hhhh.', 'heehhe', 'hmmmmh', '.bbbb.', '.b..b.'],
  ['..a...', 'hhhhhh', 'heehhe', 'hhhhhh', 'bbbbbb', 'b.bb.b'],
  ['.a..a.', '.hhhh.', 'hehheh', 'hhmmhh', 'bbbbbb', '.b..b.'],
]

// The pixel rows each density draws: the whole robot, its head and chest, its face.
const AV_PIXELS = [[0, 1, 2, 3, 4, 5], [1, 2, 3, 4], [2, 3]] as const

function avatarCells(id: string, isMain: boolean, density: Density): string {
  const px = AV_PIXELS[density]
  const rows = px.length / 2
  const h = hash(id)
  const hue = isMain ? 18 : h % 360
  const pal: Record<string, number> = {
    h: isMain ? 0xd97757 : hsl(hue, 0.55, 0.55),
    b: isMain ? 0x9a4f36 : hsl((hue + 40 + ((h >>> 9) % 140)) % 360, 0.45, 0.4),
    e: (h >>> 5) % 3 === 0 ? 0x7fffd4 : 0xf5f5f5,
    m: 0x2a2a2a,
    a: isMain ? 0xf0c040 : hsl((hue + 180) % 360, 0.7, 0.6),
  }
  const grid = ROBOTS[isMain ? 0 : (h >>> 3) % ROBOTS.length]!
  const words = new Uint32Array(AV_W * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < AV_W; c++) {
      const top = pal[grid[px[r * 2]!]![c]!]
      const bot = pal[grid[px[r * 2 + 1]!]![c]!]
      const i = (r * AV_W + c) * 3
      if (top === undefined && bot === undefined) words.set([0x20, DEFAULT, DEFAULT], i)
      else if (top === undefined) words.set([0x2584, bot!, DEFAULT], i)
      else words.set([0x2580, top, bot ?? DEFAULT], i)
    }
  }
  return (new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }).toBase64()
}

// ── Names: each agent and job gets a robot name of its own ───────────────

const NAMES = [
  'Atlas', 'Bolt', 'Cobalt', 'Dot', 'Echo', 'Flux', 'Gizmo', 'Halo', 'Ion', 'Jinx', 'Kilo', 'Lumen',
  'Mica', 'Nova', 'Orbit', 'Pixel', 'Quark', 'Rivet', 'Sprocket', 'Tango', 'Volt', 'Widget', 'Zip', 'Astro',
  'Beep', 'Chip', 'Dynamo', 'Ember', 'Fuse', 'Glitch', 'Hex', 'Iris', 'Jolt', 'Kip', 'Loop', 'Mote',
  'Nimbus', 'Piston', 'Quill', 'Servo', 'Torque', 'Vector', 'Whirr', 'Zephyr', 'Byte', 'Cog', 'Diode', 'Ratchet',
  'Gadget', 'Nibble', 'Bleep', 'Clank', 'Pip', 'Rusty', 'Sparky', 'Tinker', 'Ozzy', 'Blip', 'Cosmo', 'Dash',
  'Flicker', 'Gears', 'Mops', 'Nuts',
]

// Earliest first, so an agent keeps its name while later ones come and go.
function assignNames(list: { id: string; at: number; fixed?: string }[]): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const x of [...list].sort((a, b) => a.at - b.at)) {
    let name = x.fixed
    if (!name) {
      const h = hash(x.id)
      for (let i = 0; i < NAMES.length && !name; i++) {
        const n = NAMES[(h + i) % NAMES.length]!
        if (!used.has(n)) name = n
      }
      name ??= `${NAMES[h % NAMES.length]} ${used.size + 1}`
    }
    used.add(name)
    out.set(x.id, name)
  }
  return out
}

// ── Reading the engine's figures ─────────────────────────────────────────

async function refreshUsage($: EngineInterface) {
  const [u, model] = await Promise.all([$.session.usage(), $.session.model()])
  const next: HudUsage = {
    ctxTokens: u.context.tokens,
    ctxWindow: u.context.window,
    ctxPercent: u.context.percent,
    limits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    model,
  }
  await update($, usage, prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
}

async function refreshAgents($: EngineInterface, at: number) {
  const list = await $.agent.list()
  await update($, agents, prev => {
    const byId = new Map(prev.map(a => [a.id, a]))
    const seen = new Set<string>()
    const out: HudAgent[] = []
    for (const info of list) {
      seen.add(info.id)
      const old = byId.get(info.id)
      const isLive = LIVE.has(info.status)
      out.push({
        id: info.id,
        name: info.name ?? old?.name ?? '',
        description: info.description || old?.description || '',
        type: info.type,
        status: info.status,
        activity: isLive ? (old?.activity ?? 'idle') : 'idle',
        tool: isLive ? old?.tool : undefined,
        model: old?.model,
        ctxTokens: old?.ctxTokens,
        tools: old?.tools ?? 0,
        startedAt: old?.startedAt ?? at,
        updatedAt: old && old.status === info.status ? old.updatedAt : at,
        hint: old?.hint ?? '',
      })
    }
    // the engine drops finished agents after a while: keep them a little longer
    for (const a of prev) {
      if (seen.has(a.id)) continue
      if (at - a.updatedAt > KEEP_DONE_MS) continue
      out.push(LIVE.has(a.status) ? { ...a, status: 'completed', activity: 'idle', tool: undefined, updatedAt: at } : a)
    }
    return JSON.stringify(out) === JSON.stringify(prev) ? prev : out
  })
}

async function sha8(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)]
    .slice(0, 4)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// The lanes skill keeps its registry at ~/.local/state/lanes/<repo>-<sha256(repo)[0:8]>/lanes.tsv.
async function locateLanes($: EngineInterface): Promise<{ repo: string; dir: string } | undefined> {
  const home = await $.env.get('HOME')
  if (!home) return undefined
  let repo = await $.env.get('LANES_REPO')
  if (!repo) {
    const cwd = await $.session.cwd()
    const r = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeoutMs: 5000 })
    if (r.exitCode !== 0) return undefined
    repo = r.stdout.trim().replace(/\/+$/, '').replace(/\/[^/]+$/, '')
  }
  const base = repo.split('/').pop() ?? repo
  return { repo, dir: `${home}/.local/state/lanes/${base}-${await sha8(repo)}` }
}

function parseLanes(text: string, repo: string): HudLane[] {
  const rows: HudLane[] = []
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const [lane = '', agent = '', task = '', worktree = '', relay = ''] = line.split('\t').map(s => s.trim())
    if (lane === 'lane' || !lane) continue
    const abs = worktree.startsWith('/') ? worktree : worktree ? `${repo}/${worktree.replace(/^\.\//, '')}` : ''
    if (abs.replace(/\/+$/, '') === repo) continue // the main worktree is the orchestrator, not a lane
    rows.push({ lane, agent, task, worktree: abs, relay })
  }
  return rows
}

async function refreshLanes($: EngineInterface) {
  const prev = await read($, lanes)
  const where = prev.dir && prev.repo ? { repo: prev.repo, dir: prev.dir } : await locateLanes($)
  if (!where) return
  let rows: HudLane[] = []
  try {
    rows = parseLanes(await $.fs.read(`${where.dir}/lanes.tsv`), where.repo)
  } catch {
    rows = []
  }
  const next: HudLanes = { repo: where.repo, dir: where.dir, rows }
  await update($, lanes, p => (JSON.stringify(p) === JSON.stringify(next) ? p : next))
}

function laneOf(a: HudAgent, rows: HudLane[]): HudLane | undefined {
  let best: HudLane | undefined
  for (const r of rows) {
    const rel = r.worktree.split('/.claude/worktrees/')[1]
    const hit =
      (r.worktree && a.hint.includes(r.worktree)) ||
      (rel && a.hint.includes(`worktrees/${rel}`)) ||
      a.hint.includes(`/lanes/${r.lane}/`)
    if (hit && (!best || r.worktree.length > best.worktree.length)) best = r
  }
  return best
}

// ── External relay jobs (lanes skill: model-relay, codex-lane, codex-review) ──

// Relay subagent types and model-relay engines, by the model the work really runs on.
const ENGINE_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek V4.1 Flash',
  glm: 'GLM 5.3 Flash',
  minimax: 'MiniMax M3.1 Flash',
  'nemotron-ultra': 'Nemotron 3 Ultra',
  laguna: 'Laguna S 2.1',
  'nemotron-vl': 'Nemotron 3.5 VL',
  codex: 'Codex gpt-6.1-sol',
}

function codexLabel(model: string, effort: string): string {
  const m = model ? model.replace(/^gpt-/, 'GPT-') : 'Codex'
  return effort ? `${m} ${effort}` : m
}

// One line per job folder touched in the last 12 hours: id, engine, model, effort, cwd,
// lanedir, rc, started (cwd file's mtime), ended (rc file's mtime), pid alive.
// Plain POSIX tools, so the scan runs the same on Linux and macOS.
const JOB_SCAN = `cd "$HOME/.local/state" 2>/dev/null || exit 0
mt() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
find . -mindepth 2 -maxdepth 2 -mmin -720 \\( -path './model-relay.*' -o -path './codex-lane.*' -o -path './codex-review.*' \\) 2>/dev/null | sed 's|^\\./||; s|/[^/]*$||' | sort -u | while read -r d; do
  r() { [ -f "$d/$1" ] && head -c 300 "$d/$1" | tr '\\t\\n' '  '; }
  pid=$(sed -n 's/.*"pid": *\\([0-9]*\\).*/\\1/p' "$d/rc.process.json" 2>/dev/null)
  alive=0; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1
  ended=; [ -f "$d/rc" ] && ended=$(mt "$d/rc")
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$d" "$(r engine)" "$(r model)" "$(r effort)" "$(r cwd)" "$(r lanedir)" "$(r rc)" "$(mt "$d/cwd")" "$ended" "$alive"
done`

function parseJobs(text: string, repo: string | undefined, at: number): HudJob[] {
  const out: HudJob[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const [id = '', engine = '', model = '', effort = '', cwd = '', lanedir = '', rc = '', started = '', ended = '', alive = ''] = line
      .split('\t')
      .map(x => x.trim())
    if (!cwd || (repo && !cwd.startsWith(repo))) continue
    const kind: HudJob['kind'] = id.startsWith('model-relay.') ? 'relay' : id.startsWith('codex-review.') ? 'review' : 'codex'
    const startedAt = Number(started) * 1000 || at
    const status: HudJob['status'] =
      rc !== '' ? (rc === '0' ? 'done' : 'failed') : alive === '1' || at - startedAt < 10 * 60_000 ? 'running' : 'stopped'
    const parts = lanedir.split('/').filter(Boolean)
    const lane = (/^r\d+$/.test(parts[parts.length - 1] ?? '') ? parts[parts.length - 2] : parts[parts.length - 1]) ?? ''
    out.push({
      id,
      kind,
      engine: engine || 'codex',
      model: kind === 'relay' ? (ENGINE_LABEL[engine] ?? engine) : codexLabel(model, effort),
      effort,
      cwd,
      lane,
      status,
      startedAt,
      endedAt: ended ? Number(ended) * 1000 : undefined,
    })
  }
  return out.sort((a, b) => a.startedAt - b.startedAt)
}

async function refreshJobs($: EngineInterface) {
  const [l, at] = await Promise.all([read($, lanes), $.clock.now()])
  if (!l.repo) return
  const r = await $.process.run(['bash', '-c', JOB_SCAN], { timeoutMs: 15_000 })
  if (r.exitCode !== 0) return
  const next = parseJobs(r.stdout, l.repo, at).filter(j => j.status === 'running' || at - (j.endedAt ?? j.startedAt) < KEEP_DONE_MS)
  await update($, jobs, prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
}

function jobLane(j: HudJob, rows: HudLane[]): HudLane | undefined {
  return rows.find(r => r.lane === j.lane) ?? rows.find(r => r.worktree && j.cwd.replace(/\/+$/, '') === r.worktree.replace(/\/+$/, ''))
}

// A relay subagent drives its own model-relay job: show the agent, not the job too.
function isShadowed(j: HudJob, ag: HudAgent[]): boolean {
  return ag.some(a => a.type === j.engine && a.hint.includes(j.cwd) && Math.abs(a.startedAt - j.startedAt) < 15 * 60_000)
}

function jobCard(E: Els, v: View, j: HudJob, cols: number): RenderChildren {
  const st =
    j.status === 'running'
      ? { icon: '⚡', label: j.kind === 'review' ? 'Reviewing' : 'Running', color: 'success' }
      : j.status === 'done'
        ? { icon: '✔', label: 'Done', color: 'subtle' }
        : j.status === 'failed'
          ? { icon: '✘', label: 'Failed', color: 'error' }
          : { icon: '■', label: 'Stopped', color: 'error' }
  const dur = fmtDur((j.endedAt ?? v.at) - j.startedAt)
  const role = j.kind === 'review' ? 'review' : j.kind === 'codex' ? 'codex-lane' : 'relay'
  return Card(
    E,
    v,
    {
      id: j.id,
      isMain: false,
      nick: v.nick.get(j.id) ?? j.engine,
      title: j.lane || j.engine,
      branch: j.cwd.split('/').pop() ?? '',
      st,
      extra: `${role}  ${j.status === 'running' ? dur : `${dur} · ${fmtDur(v.at - (j.endedAt ?? j.startedAt))} ago`}`,
      model: j.model,
      noCtx: true,
    },
    cols,
  )
}

// ── Drawing ──────────────────────────────────────────────────────────────

function statusOf(a: { status: string; activity: HudActivity; tool?: string }): { icon: string; label: string; color: string } {
  if (LIVE.has(a.status)) {
    if (a.activity === 'thinking') return { icon: '✻', label: 'Thinking', color: 'warning' }
    if (a.activity === 'generating') return { icon: '⚡', label: 'Generating', color: 'success' }
    if (a.activity === 'tool') return { icon: '⚙', label: a.tool ?? 'Tool', color: 'suggestion' }
    if (a.status === 'pending') return { icon: '◌', label: 'Starting', color: 'subtle' }
    if (a.status === 'waiting') return { icon: '◷', label: 'Waiting', color: 'subtle' }
    return { icon: '●', label: 'Working', color: 'success' }
  }
  if (a.status === 'failed') return { icon: '✘', label: 'Failed', color: 'error' }
  if (a.status === 'killed') return { icon: '■', label: 'Stopped', color: 'error' }
  if (a.status === 'completed') return { icon: '✔', label: 'Done', color: 'subtle' }
  return { icon: 'ⓘ', label: 'Idle', color: 'suggestion' }
}

function Avatar(E: Els, v: View, id: string, isMain: boolean) {
  const { Box, Text } = E
  if (v.raster && 'Raster' in E) {
    const { Raster } = E as Els & { Raster: ElementConstructor<RasterProps> }
    return (
      <Box width={AV_W} flexShrink={0}>
        <Raster key={`av${v.density}-${id}`} columns={AV_W} rows={AV_PIXELS[v.density].length / 2} cells={avatarCells(id, isMain, v.density)} />
      </Box>
    )
  }
  return (
    <Box width={3} flexShrink={0}>
      <Text color={isMain ? 'claude' : 'suggestion'}>{isMain ? '✻' : '◆'}</Text>
    </Box>
  )
}

function CtxBar(E: Els, pct: number | undefined, w: number) {
  const { Text } = E
  if (pct === undefined) return <Text dimColor>{'─'.repeat(w)}   –</Text>
  const [on, off] = barText(pct, w)
  return (
    <Text>
      <Text color={pctColor(pct)}>{on}</Text>
      <Text dimColor>{off}</Text>
      <Text color={pctColor(pct)}> {String(Math.round(pct)).padStart(3)}%</Text>
    </Text>
  )
}

type CardData = {
  id: string
  isMain: boolean
  /** The robot name, drawn bold. */
  nick: string
  /** What it's doing (the brief's description), drawn after the name. */
  title: string
  branch: string
  st: { icon: string; label: string; color: string }
  extra: string
  model: string
  pct?: number
  noCtx?: boolean
  onPress?: () => void
}

function Card(E: Els, v: View, d: CardData, cols: number) {
  const { Box, Text, Button } = E
  const tiny = v.density === 2
  const inner = Math.max(16, cols - (v.raster ? AV_W : 3) - 3)
  const barW = tiny ? 0 : Math.max(4, Math.min(12, Math.floor(inner / 3)))
  const right = tiny ? `${d.st.icon} ${cut(d.st.label, 10)} ${d.noCtx ? 'ext' : d.pct === undefined ? '  –' : `${String(Math.round(d.pct)).padStart(3)}%`}` : ''
  const left = Math.max(6, inner - (tiny ? right.length + 1 : barW + 6))
  // The name whole, then the branch (up to about half of what's left), then the description.
  const nick = cut(d.nick, Math.max(4, left - 8))
  const free = left - nick.length
  const descNeed = d.title ? d.title.length + 1 : 0
  const branchNeed = d.branch.length + 3
  const branchW = branchNeed + descNeed <= free ? branchNeed : Math.min(branchNeed, Math.max(Math.floor(free * 0.55), free - descNeed))
  const descW = free - branchW
  const rest = d.title && descW > 2 ? ` ${cut(d.title, descW - 1)}` : ''
  const branch = cut(d.branch, Math.max(2, branchW - 3))
  const label = [<Text bold>{nick}</Text>, <Text>{rest}</Text>, <Text dimColor> ⎇ {branch}</Text>]
  const head = d.onPress ? (
    <Button key={`view-${d.id}`} plain onPress={d.onPress}>
      {label}
    </Button>
  ) : (
    <Text wrap="truncate-end">{label}</Text>
  )
  if (tiny) {
    return (
      <Box key={`card-${d.id}`} flexDirection="row" gap={1}>
        {Avatar(E, v, d.id, d.isMain)}
        <Box flexDirection="row" flexGrow={1} justifyContent="space-between">
          <Box flexShrink={1}>{head}</Box>
          <Text color={d.st.color}>{right}</Text>
        </Box>
      </Box>
    )
  }
  return (
    <Box key={`card-${d.id}`} flexDirection="row" gap={1} marginBottom={v.density === 0 ? 1 : 0}>
      {Avatar(E, v, d.id, d.isMain)}
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexShrink={1}>{head}</Box>
          {d.noCtx ? <Text dimColor>external</Text> : CtxBar(E, d.pct, barW)}
        </Box>
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color={d.st.color}>
              {d.st.icon} {cut(d.st.label, 22)}
            </Text>
            {d.extra ? <Text dimColor>  {d.extra}</Text> : null}
          </Text>
          <Text dimColor>{d.model}</Text>
        </Box>
      </Box>
    </Box>
  )
}

function windowFor(model: string | undefined, v: View): number {
  if (model && /\[1m\]/i.test(model)) return 1_000_000
  if (model && v.u?.model && prettyModel(model) === prettyModel(v.u.model)) return v.u.ctxWindow
  return 200_000
}

function agentCard(E: Els, v: View, a: HudAgent, cols: number, $: EngineInterface, branch?: string): RenderChildren {
  const st = statusOf(a)
  const isLive = LIVE.has(a.status)
  const bits = [`⚒ ${a.tools}`, isLive ? fmtDur(v.at - a.startedAt) : `${fmtDur(v.at - a.updatedAt)} ago`]
  const relay = ENGINE_LABEL[a.type]
  const pct = !relay && a.ctxTokens !== undefined ? (a.ctxTokens / windowFor(a.model, v)) * 100 : undefined
  return Card(
    E,
    v,
    {
      id: a.id,
      isMain: false,
      nick: v.nick.get(a.id) ?? a.type,
      title: a.description || (a.name ? a.type : ''),
      branch: branch ?? a.type,
      st,
      extra: bits.join('  '),
      model: relay ?? prettyModel(a.model),
      pct,
      noCtx: !!relay,
      onPress: () => void $.ui.view({ agentId: a.id }).catch(() => undefined),
    },
    cols,
  )
}

function mainCard(E: Els, v: View, cols: number, branch: string): RenderChildren {
  const st = statusOf({ status: v.m.working ? 'running' : 'idle', activity: v.m.activity, tool: v.m.tool })
  const running = v.ag.filter(a => LIVE.has(a.status)).length
  const bits = [`⚒ ${v.m.tools}`]
  if (v.m.working) bits.push(fmtDur(v.at - v.m.turnStartedAt))
  if (running) bits.push(`${running} running`)
  return Card(
    E,
    v,
    { id: 'main', isMain: true, nick: 'This session', title: '', branch, st, extra: bits.join('  '), model: prettyModel(v.u?.model), pct: v.u?.ctxPercent },
    cols,
  )
}

const LIMIT_LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet' }

function UsageRow(E: Els, label: string, pct: number | undefined, cols: number, right: string) {
  const { Box, Text } = E
  const labelW = 9
  const pctW = 5
  const rightW = Math.min(right.length, Math.max(0, cols - labelW - pctW - 8))
  const barW = Math.max(4, cols - labelW - pctW - rightW - 2)
  const [on, off] = barText(pct ?? 0, barW)
  const c = pct === undefined ? 'subtle' : pctColor(pct)
  return (
    <Box key={`use-${label}`} flexDirection="row">
      <Text wrap="truncate-end">
        <Text bold>{label.padEnd(labelW).slice(0, labelW)}</Text>
        <Text color={c}>{on}</Text>
        <Text dimColor>{off}</Text>
        <Text color={c}>{(pct === undefined ? '–' : `${Math.round(pct)}%`).padStart(pctW)}</Text>
        {rightW > 0 ? <Text dimColor> {cut(right, rightW)}</Text> : null}
      </Text>
    </Box>
  )
}

function Footer(E: Els, v: View, cols: number) {
  const { Box, Text } = E
  const u = v.u
  const lim = (k: string): HudLimit | undefined => u?.limits.find(l => l.kind === k)
  const reset = (l?: HudLimit, withDay = false) => {
    const t = l?.resetsAt ? Date.parse(l.resetsAt) : NaN
    if (!Number.isFinite(t)) return ''
    return `↻ ${fmtDur(t - v.at)} · ${fmtClock(t, withDay)}`
  }
  const five = lim('five_hour')
  const week = lim('seven_day')
  const others = (u?.limits ?? []).filter(l => l.kind !== 'five_hour' && l.kind !== 'seven_day')
  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(cols)}</Text>
      {UsageRow(E, 'Context', u?.ctxPercent, cols, u?.ctxTokens !== undefined ? `${fmtTokens(u.ctxTokens)}/${fmtTokens(u.ctxWindow)}` : '')}
      {UsageRow(E, '5-hour', five?.percentUsed, cols, reset(five))}
      {UsageRow(E, 'Weekly', week?.percentUsed, cols, reset(week, true))}
      {others.map(l => UsageRow(E, LIMIT_LABEL[l.kind] ?? l.kind, l.percentUsed, cols, reset(l, true)))}
      {!five && !week ? <Text dimColor>Plan limits arrive with the next response.</Text> : null}
    </Box>
  )
}

function Header(E: Els, v: View, cols: number) {
  const { Box, Text } = E
  const running = v.ag.filter(a => LIVE.has(a.status)).length + v.jobs.filter(j => j.status === 'running' && !isShadowed(j, v.ag)).length
  const label = v.isLanes ? `Lanes · ${v.l.repo?.split('/').pop() ?? '?'}` : 'Agents'
  const count = v.isLanes ? `${v.l.rows.length} lanes · ${running} running` : `${v.ag.length} · ${running} running`
  return (
    <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
      <Text bold color="claude">
        {label}
      </Text>
      <Text dimColor>{cut(count, Math.max(4, cols - label.length - 2))}</Text>
    </Box>
  )
}

type Item = { node: RenderChildren; rows: number }

function Indent(E: Els, key: string, node: RenderChildren): RenderChildren {
  const { Box } = E
  return (
    <Box key={key} paddingLeft={2}>
      {node}
    </Box>
  )
}

function laneItems(E: Els, v: View, cols: number, $: EngineInterface): Item[] {
  const { Box, Text } = E
  const card = CARD_ROWS[v.density]
  const groups = new Map<string, HudAgent[]>()
  const loose: HudAgent[] = []
  for (const a of v.ag) {
    const r = laneOf(a, v.l.rows)
    if (r) groups.set(r.lane, [...(groups.get(r.lane) ?? []), a])
    else loose.push(a)
  }
  const out: Item[] = []
  if (v.l.rows.length === 0) out.push({ node: <Text dimColor>No lanes registered yet (lanes.tsv is empty).</Text>, rows: 1 })
  for (const r of v.l.rows) {
    const list = groups.get(r.lane) ?? []
    const laneJobs = v.jobs.filter(j => jobLane(j, v.l.rows) === r && !isShadowed(j, v.ag))
    const live = list.filter(a => LIVE.has(a.status)).length + laneJobs.filter(j => j.status === 'running').length
    out.push({
      rows: r.task ? 2 : 1,
      node: (
        <Box key={`lane-${r.lane}`} flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={live ? 'success' : 'subtle'}>{live ? '▌' : '▏'}</Text>
            <Text bold> {r.lane}</Text>
            <Text dimColor> · {r.agent}</Text>
          </Text>
          {r.task ? (
            <Text dimColor wrap="truncate-end">
              {'  '}
              {r.task}
            </Text>
          ) : null}
        </Box>
      ),
    })
    if (list.length === 0 && laneJobs.length === 0) {
      out.push({
        rows: 2,
        node: (
          <Box key={`none-${r.lane}`} marginBottom={1}>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {r.relay && r.relay !== '-' && r.relay !== 'agent' ? `relay ${r.relay}` : 'no agent in this session'}
            </Text>
          </Box>
        ),
      })
      continue
    }
    const wt = r.worktree.split('/').pop() ?? r.lane
    for (const a of list) out.push({ rows: card, node: Indent(E, `in-${a.id}`, agentCard(E, v, a, cols - 2, $, wt)) })
    for (const j of laneJobs) out.push({ rows: card, node: Indent(E, `in-${j.id}`, jobCard(E, v, j, cols - 2)) })
    if (v.density !== 0) out.push({ rows: 1, node: <Text key={`gap-${r.lane}`}> </Text> })
  }
  const looseJobs = v.jobs.filter(j => !jobLane(j, v.l.rows) && !isShadowed(j, v.ag))
  if (looseJobs.length) {
    out.push({ rows: 1, node: <Text bold dimColor>External jobs</Text> })
    for (const j of looseJobs) out.push({ rows: card, node: jobCard(E, v, j, cols) })
  }
  if (loose.length) {
    out.push({ rows: 1, node: <Text bold dimColor>Other agents</Text> })
    for (const a of loose) out.push({ rows: card, node: agentCard(E, v, a, cols, $) })
  }
  return out
}

function agentItems(E: Els, v: View, cols: number, $: EngineInterface): Item[] {
  const { Text } = E
  const card = CARD_ROWS[v.density]
  const ext = v.jobs.filter(j => !isShadowed(j, v.ag))
  return [
    ...v.ag.map(a => ({ rows: card, node: agentCard(E, v, a, cols, $, laneOf(a, v.l.rows)?.lane) })),
    ...(ext.length ? [{ rows: 1, node: <Text bold dimColor>External jobs</Text> }] : []),
    ...ext.map(j => ({ rows: card, node: jobCard(E, v, j, cols) })),
  ]
}

function footerRows(v: View): number {
  const limits = v.u?.limits ?? []
  const others = limits.filter(l => l.kind !== 'five_hour' && l.kind !== 'seven_day').length
  const known = limits.some(l => l.kind === 'five_hour' || l.kind === 'seven_day')
  return 4 + others + (known ? 0 : 1)
}

async function view($: EngineInterface, surface: string): Promise<View> {
  const [ag, m, u, l, inv, md, at, jb] = await Promise.all([
    read($, agents),
    read($, main),
    read($, usage),
    read($, lanes),
    read($, lanesInvoked),
    read($, mode),
    read($, now),
    read($, jobs),
  ])
  const isLanes = md === 'lanes' || (md === 'auto' && inv)
  const nick = assignNames([
    ...ag.map(a => ({ id: a.id, at: a.startedAt, fixed: a.name || undefined })),
    ...jb.map(j => ({ id: j.id, at: j.startedAt })),
  ])
  return { ag, m, u, l, jobs: jb, isLanes, at, raster: surface === 'terminal', nick, density: 0 }
}

// ── Registration ─────────────────────────────────────────────────────────

const MAIN_ID = '__main__'

function setActivity($: EngineInterface, id: string, activity: HudActivity, tool?: string) {
  if (id === MAIN_ID) {
    return update($, main, m => (m.activity === activity && m.tool === tool ? m : { ...m, activity, tool }))
  }
  return update($, agents, list =>
    list.some(a => a.id === id && (a.activity !== activity || a.tool !== tool))
      ? list.map(a => (a.id === id ? { ...a, activity, tool } : a))
      : list,
  )
}

function toolLabel(tool: string): string {
  return tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool
}

async function markLanes($: EngineInterface) {
  await update($, lanesInvoked, () => true)
  await refreshLanes($).catch(() => undefined)
}

export const register: Register = on => {
  let ticker: { cancel: () => void } | undefined
  let ticks = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'agents-hud', description: 'Agents HUD: open the panel. Args: lanes | agents | auto (grouping)' })
    await update($, now, () => Date.now())
    await Promise.all([refreshUsage($), refreshAgents($, Date.now()), refreshLanes($)].map(p => p.catch(() => undefined)))
    await refreshJobs($).catch(() => undefined)
    void $.ui.open({ id: PANE, title: TITLE })

    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      ticks += 1
      void (async () => {
        const at = await $.clock.now()
        const [ag, m] = await Promise.all([read($, agents), read($, main)])
        const isBusy = m.working || ag.some(a => LIVE.has(a.status))
        if (isBusy || ticks % 5 === 0) {
          await update($, now, () => at)
          await refreshAgents($, at)
        }
        if (ticks % 5 === 0) await refreshLanes($)
        const jb = await read($, jobs)
        if (ticks % (jb.some(j => j.status === 'running') ? 5 : 15) === 0) await refreshJobs($)
        if (ticks % 15 === 0) await refreshUsage($)
      })().catch(() => undefined)
    })
    return result
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    return next(e)
  })

  on('command.run', { command: 'agents-hud' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'lanes' || arg === 'agents' || arg === 'auto') await update($, mode, () => arg as HudMode)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const md = await read($, mode)
    return {
      text: opened.isPlaced
        ? `Agents HUD open (grouping: ${md}).`
        : `Agents HUD ready (grouping: ${md}); it shows once the terminal is wide enough or in fullscreen mode.`,
    }
  })

  on('skill.prompt', async ($, e, next) => {
    if (e.skill === 'lanes' || e.skill.endsWith(':lanes')) await markLanes($).catch(() => undefined)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, main, m => ({ ...m, working: true, turnStartedAt: at, activity: 'thinking' as const, tool: undefined }))
    await update($, now, () => at)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId) {
      const id = result.agentId
      const at = await $.clock.now()
      const hint = `${e.cwd ?? ''}\n${e.prompt.slice(0, 4000)}`
      const entry: HudAgent = {
        id,
        name: e.name ?? '',
        description: e.description,
        type: e.subagentType,
        status: 'pending',
        activity: 'idle',
        model: result.model,
        tools: 0,
        startedAt: at,
        updatedAt: at,
        hint,
      }
      await update($, agents, list =>
        list.some(a => a.id === id) ? list.map(a => (a.id === id ? { ...a, hint, model: a.model ?? result.model } : a)) : [...list, entry],
      )
      if (/\/lanes\/|\.claude\/worktrees\//.test(hint)) await refreshLanes($).catch(() => undefined)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN_ID
    const tool = String(e.tool)
    if (id === MAIN_ID) await update($, main, m => ({ ...m, tools: m.tools + 1 }))
    else await update($, agents, list => list.map(a => (a.id === id ? { ...a, tools: a.tools + 1 } : a)))
    await setActivity($, id, 'tool', toolLabel(tool))
    if (tool === 'Skill') {
      const s = String((e as unknown as { skill?: string }).skill ?? '')
      if (s === 'lanes' || s.endsWith(':lanes')) await markLanes($).catch(() => undefined)
    }
    const result = await next(e)
    await setActivity($, id, 'thinking')
    if (tool === 'Bash') {
      const cmd = String((e as unknown as { command?: string }).command ?? '')
      if (cmd.includes('skills/lanes/') || cmd.includes('lanes.tsv')) await markLanes($).catch(() => undefined)
      if (/model-relay|codex-lane|codex-review/.test(cmd)) await refreshJobs($).catch(() => undefined)
    }
    if (tool === 'Agent') await refreshAgents($, await $.clock.now()).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? MAIN_ID
    const stream = next(e)
    let last = ''
    for await (const chunk of stream) {
      if (chunk.kind !== last && (chunk.kind === 'thinking' || chunk.kind === 'text' || chunk.kind === 'tool')) {
        last = chunk.kind
        const act: HudActivity = chunk.kind === 'thinking' ? 'thinking' : chunk.kind === 'text' ? 'generating' : 'tool'
        void setActivity($, id, act, chunk.kind === 'tool' ? toolLabel(chunk.name) : undefined).catch(() => undefined)
      }
      yield chunk
    }
    const result = await stream.result
    const u = result.usage
    if (id !== MAIN_ID && u) {
      const ctx = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
      await update($, agents, list => list.map(a => (a.id === id ? { ...a, ctxTokens: ctx, model: u.model } : a)))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const at = await $.clock.now()
    if (e.agentId) {
      await setActivity($, e.agentId, 'idle')
      await refreshAgents($, at).catch(() => undefined)
    } else {
      await update($, main, m => ({ ...m, working: false, activity: 'idle' as const, tool: undefined }))
      await refreshUsage($).catch(() => undefined)
    }
    await update($, now, () => at)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refreshUsage($).catch(() => undefined)
    return result
  })

  // While the cards outgrow the panel, the header, this session and the footer
  // stay put and the cards between them scroll a row at a time.
  const paging = { active: false, max: 0, page: 1 }

  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (!paging.active) return next(e)
    const dir = Math.sign(e.by)
    const by = Math.abs(e.by) >= Math.max(2, e.bodyRows) ? paging.page : Math.abs(e.by)
    if (dir) await update($, skip, s => Math.max(0, Math.min(paging.max, Math.min(s, paging.max) + dir * by)))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const E = $.ui.resolve(e)
    const { Box, Button, Text } = E
    const base = await view($, e.surface)
    const cols = Math.max(24, e.props.bodyColumns)
    const branch = base.isLanes ? 'orchestrator' : (base.l.repo?.split('/').pop() ?? 'main')
    const budget = e.props.scroll.bodyRows
    let v = base
    let items: Item[] = []
    let room = 0
    for (const density of [0, 1, 2] as const) {
      v = { ...base, density }
      items = base.isLanes ? laneItems(E, v, cols, $) : agentItems(E, v, cols, $)
      room = budget - 2 - CARD_ROWS[density] - footerRows(v)
      if (items.reduce((n, i) => n + i.rows, 0) <= room) break
    }
    const total = items.reduce((n, i) => n + i.rows, 0)
    paging.active = total > room
    let body = items
    let above = 0
    let below = 0
    if (paging.active) {
      const win = Math.max(1, room - 2)
      let tail = 0
      let max = items.length
      while (max > 0 && tail + items[max - 1]!.rows <= win) tail += items[--max]!.rows
      paging.max = max
      const first = Math.min(await read($, skip), max)
      let used = 0
      let last = first
      while (last < items.length && used + items[last]!.rows <= win) used += items[last++]!.rows
      if (last === first) last = first + 1
      paging.page = Math.max(1, last - first - 1)
      body = items.slice(first, last)
      above = first
      below = items.length - last
    }
    const more = (n: number, dir: 1 | -1) =>
      n ? (
        <Button key={dir < 0 ? 'more-up' : 'more-down'} plain onPress={() => void update($, skip, s => Math.max(0, Math.min(paging.max, Math.min(s, paging.max) + dir * paging.page)))}>
          <Text dimColor>
            {dir < 0 ? '▲' : '▼'} {n} more {dir < 0 ? 'above' : 'below'}
          </Text>
        </Button>
      ) : (
        <Text> </Text>
      )
    return (
      <Box flexDirection="column" height="100%">
        {Header(E, v, cols)}
        {mainCard(E, v, cols, branch)}
        {paging.active ? more(above, -1) : null}
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {body.map(i => i.node)}
        </Box>
        {paging.active ? more(below, 1) : null}
        {Footer(E, v, cols)}
      </Box>
    )
  })
}
