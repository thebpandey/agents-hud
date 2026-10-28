import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, RasterProps, Register, RenderChildren, SvgProps } from 'claude-code'

import type { HudActivity, HudAgent, HudBreakdown, HudJob, HudLane, HudLanes, HudLimit, HudMain, HudMode, HudPlacement, HudUsage } from '../types'

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
const expanded = atom({ plugin: 'agents-hud', key: 'expanded' } as const, false)
const INITIAL_BREAKDOWN: HudBreakdown | null = null
const breakdown = atom({ plugin: 'agents-hud', key: 'breakdown' } as const, INITIAL_BREAKDOWN)
const theme = atom({ plugin: 'agents-hud', key: 'theme' } as const, 0)
const avatars = atom({ plugin: 'agents-hud', key: 'avatars' } as const, 'robots')
const showIdle = atom({ plugin: 'agents-hud', key: 'showIdle' } as const, false)
const frame = atom({ plugin: 'agents-hud', key: 'frame' } as const, 0)
const motion = atom({ plugin: 'agents-hud', key: 'motion' } as const, true)
const INITIAL_PLACEMENT: HudPlacement = 'panel'
const placement = atom({ plugin: 'agents-hud', key: 'placement' } as const, INITIAL_PLACEMENT)

const PANE = 'agents-hud'
const TITLE = 'Agents'

// Read from the manifest once per load, so the header can't drift from the release.
let manifestVersion: Promise<string | undefined> | undefined
function pluginVersion($: EngineInterface): Promise<string | undefined> {
  manifestVersion ??= $.fs
    .read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    .then(text => {
      const m: unknown = JSON.parse(text)
      return typeof m === 'object' && m !== null && 'version' in m && typeof m.version === 'string' ? m.version : undefined
    })
    .catch(() => undefined)
  return manifestVersion
}
const TICK_MS = 2000
const ANIM_MS = 450
const GUTTER = 1
const KEEP_DONE_MS = 30 * 60_000
const LIVE = new Set(['pending', 'running', 'waiting'])

type Els = ReturnType<EngineInterface['ui']['resolve']>
type View = {
  ag: HudAgent[]
  m: HudMain
  u: HudUsage | null
  b: HudBreakdown | null
  l: HudLanes
  jobs: HudJob[]
  isLanes: boolean
  at: number
  raster: boolean
  nick: Map<string, string>
  t: Theme
  style: string
  open: boolean
  where: HudPlacement
  showIdle: boolean
  /** The animation frame; only the panel reads it, so the band isn't redrawn per frame. */
  f: number
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
  if (withDay) Object.assign(opts, { weekday: 'short', month: 'short', day: 'numeric' })
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

// ── Themes: one accent in three shades; picked by the person, kept across sessions ──

/** `stops`: the accent in three shades. `meters`: the Context, 5-hour and Weekly bars' own colours. */
type Theme = { name: string; stops?: [string, string, string]; meters: [string, string, string] }

const THEMES: Theme[] = [
  { name: 'Claude', stops: ['#A8553A', '#D97757', '#EBA285'], meters: ['#D97757', '#5FB3A8', '#9C8AD9'] },
  { name: 'Ember', stops: ['#7F1D1D', '#B91C1C', '#E05252'], meters: ['#E05252', '#5FB3A8', '#8C9EFF'] },
  { name: 'Amber', stops: ['#78350F', '#B45309', '#D9A441'], meters: ['#D9A441', '#6C9BC8', '#C2546F'] },
  { name: 'Harbor', stops: ['#1E3A5F', '#2F5D8A', '#6C9BC8'], meters: ['#6C9BC8', '#5FB3A8', '#B48EAD'] },
  { name: 'Forest', stops: ['#1F4D33', '#2F7A4E', '#6BAA75'], meters: ['#6BAA75', '#6C9BC8', '#B48EAD'] },
  { name: 'Bone', stops: ['#57534E', '#A8A29E', '#E7E5E4'], meters: ['#E7E5E4', '#A8A29E', '#78716C'] },
  { name: 'Wine', stops: ['#4C0519', '#881337', '#C2546F'], meters: ['#C2546F', '#6C9BC8', '#9C8AD9'] },
  // The terminal's own theme colours, for light backgrounds.
  { name: 'Terminal', meters: ['claude', 'suggestion', 'permission'] },
]

function themeOf(i: number): Theme {
  return THEMES[((i % THEMES.length) + THEMES.length) % THEMES.length]!
}

function rgb(c: string): [number, number, number] {
  const h = c.replace('#', '')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

const accent = (t: Theme) => (t.stops ? t.stops[1] : 'claude')

async function nextTheme($: EngineInterface, name?: string): Promise<Theme> {
  const want = name ? THEMES.findIndex(t => t.name.toLowerCase() === name.toLowerCase()) : -1
  const i = await update($, theme, n => (want >= 0 ? want : (n + 1) % THEMES.length))
  await $.store.set('theme', i).catch(() => undefined)
  return themeOf(i)
}

// ── Avatar: a 6×6 pixel robot, two pixels per cell ───────────────────────

const AV_W = 6
const DEFAULT = 0x01000000
// Each style's first sprite is this session's. Letters: h body, b second colour,
// e eyes, m mouth, a accent; '.' is empty.
const AVATARS: Record<string, string[][]> = {
  robots: [
    ['..aa..', '.hhhh.', 'heehhe', 'hhmmhh', '.bbbb.', 'bb..bb'],
    ['a....a', '.hhhh.', 'heehhe', 'hmmmmh', '.bbbb.', '.b..b.'],
    ['..a...', 'hhhhhh', 'heehhe', 'hhhhhh', 'bbbbbb', 'b.bb.b'],
    ['.a..a.', '.hhhh.', 'hehheh', 'hhmmhh', 'bbbbbb', '.b..b.'],
  ],
  cats: [
    ['h....h', 'hh..hh', 'hhhhhh', 'hehheh', 'hhaahh', '.hhhh.'],
    ['b....b', 'bh..hb', 'hhhhhh', 'hehheh', 'hhmmhh', 'bhhhhb'],
    ['h....h', 'hhhhhh', 'hehheh', 'hhaahh', '.hhhh.', '.h..hb'],
    ['b....b', 'hb..bh', 'hhhhhh', 'eehhee', 'hhmmhh', '.bhhb.'],
  ],
  slimes: [
    ['......', '..hh..', '.hhhh.', 'hehheh', 'hhmmhh', 'bbbbbb'],
    ['...a..', '..hh..', '.hhhh.', 'hehheh', 'hhhhhh', 'bhbbhb'],
    ['..a.a.', '.hhhh.', 'hhhhhh', 'heehee', 'hhmmhh', 'bbbbbb'],
    ['......', '.hhhh.', 'hehheh', 'hhaahh', 'hhhhhh', 'b.bb.b'],
  ],
  aliens: [
    ['a....a', '.hhhh.', 'hhhhhh', 'eehhee', '.hmmh.', '..bb..'],
    ['..aa..', '.hhhh.', 'hehheh', 'hhhhhh', 'b.hh.b', '.b..b.'],
    ['a.aa.a', 'hhhhhh', 'heehee', 'hhmmhh', '.bbbb.', 'b....b'],
    ['.a..a.', '.hhhh.', 'eehhee', 'hhhhhh', '.hbbh.', 'h.bb.h'],
  ],
  // Faces: bear, fox, panda, bunny, frog, mouse, pig, monkey, koala, penguin, lion, dog.
  animals: [
    ['bb..bb', 'bhhhhb', 'hehheh', 'hhmmhh', 'hhaahh', '.hhhh.'],
    ['h....h', 'hh..hh', 'hhhhhh', 'hehheh', '.bmmb.', '..bb..'],
    ['m....m', 'hhhhhh', 'mehhem', 'hhmmhh', 'hhhhhh', '.hhhh.'],
    ['.h..h.', '.a..a.', '.hhhh.', 'hehheh', 'hhaahh', '.hhhh.'],
    ['hh..hh', 'emhhme', 'hhhhhh', 'hmmmmh', 'hhhhhh', '.b..b.'],
    ['hh..hh', 'ha..ah', '.hhhh.', 'hehheh', '.hmmh.', '..hh..'],
    ['h....h', 'hhhhhh', 'hehheh', 'hammah', 'hhhhhh', '.hhhh.'],
    ['.hhhh.', 'hhhhhh', 'aehhea', 'abbbba', '.bmmb.', '..bb..'],
    ['bb..bb', 'bbhhbb', 'hehheh', 'hhmmhh', 'hhmmhh', '.hhhh.'],
    ['.mmmm.', 'mhhhhm', 'mehhem', 'mhaahm', 'mhhhhm', '.a..a.'],
    ['bbbbbb', 'bhhhhb', 'behheb', 'bhmmhb', 'bhhhhb', '.bbbb.'],
    ['.hhhh.', 'bhhhhb', 'behheb', 'bhmmhb', '.haah.', '..hh..'],
  ],
  owls: [
    ['b....b', 'hhhhhh', 'eehhee', 'hhaahh', 'hbbbbh', '.a..a.'],
    ['h....h', 'hbhhbh', 'eehhee', 'hhaahh', 'hbbbbh', '.a..a.'],
    ['bb..bb', 'hhhhhh', 'eehhee', 'mhaahm', '.bbbb.', '.a..a.'],
    ['.b..b.', 'hhhhhh', 'eehhee', 'hhaahh', 'bhbbhb', '.a..a.'],
  ],
}
const AVATAR_STYLES = Object.keys(AVATARS)

async function nextAvatars($: EngineInterface, name?: string): Promise<string> {
  const want = name && AVATARS[name.toLowerCase()] ? name.toLowerCase() : undefined
  const style = await update($, avatars, cur => want ?? AVATAR_STYLES[(AVATAR_STYLES.indexOf(cur) + 1) % AVATAR_STYLES.length]!)
  await $.store.set('avatars', style).catch(() => undefined)
  return style
}

// The pixel rows each density draws: the whole robot, its head and chest, its face.
const AV_PIXELS = [[0, 1, 2, 3, 4, 5], [1, 2, 3, 4], [2, 3]] as const

/** What an avatar is doing, which picks its motion; 'still' draws it at rest. */
type Motion = 'still' | 'thinking' | 'generating' | 'tool' | 'running'

// Per motion: how often it dips a pixel (in frames, 0 never), and whether it blinks or flashes.
const MOVES: Record<Motion, { dip: number; blink: boolean; flash: boolean }> = {
  still: { dip: 0, blink: false, flash: false },
  thinking: { dip: 4, blink: true, flash: false },
  generating: { dip: 1, blink: false, flash: false },
  tool: { dip: 1, blink: false, flash: true },
  running: { dip: 2, blink: false, flash: false },
}

const CELLS = new Map<string, string>()

function avatarCells(id: string, isMain: boolean, density: Density, t: Theme, style: string, mo: Motion = 'still', f = 0, as: 'raster' | 'svg' = 'raster'): string {
  const h = hash(id)
  const mv = MOVES[mo]
  const step = f + (h % 7)
  const dip = mv.dip > 0 && Math.floor(step / mv.dip) % 2 === 1
  const shut = mv.blink && step % 6 === 0
  const flash = mv.flash && step % 2 === 0
  const memo = `${as}|${id}|${isMain}|${density}|${t.name}|${style}|${dip}|${shut}|${flash}`
  const hit = CELLS.get(memo)
  if (hit) return hit
  if (CELLS.size > 2000) CELLS.clear()
  const px = AV_PIXELS[density]
  const rows = px.length / 2
  const hue = isMain ? 18 : h % 360
  const pal: Record<string, number> = {
    h: isMain ? (t.stops ? parseInt(t.stops[1].slice(1), 16) : 0xd97757) : hsl(hue, 0.55, 0.55),
    b: isMain ? (t.stops ? parseInt(t.stops[0].slice(1), 16) : 0x9a4f36) : hsl((hue + 40 + ((h >>> 9) % 140)) % 360, 0.45, 0.4),
    e: (h >>> 5) % 3 === 0 ? 0x7fffd4 : 0xf5f5f5,
    m: 0x2a2a2a,
    a: isMain ? 0xf0c040 : hsl((hue + 180) % 360, 0.7, 0.6),
  }
  const set = AVATARS[style] ?? AVATARS.robots!
  const base = set[isMain ? 0 : (h >>> 3) % set.length]!
  // A dip draws the sprite a pixel lower; a blink closes the eyes; a flash lights the accent.
  const grid = (dip ? ['......', ...base.slice(0, 5)] : base).map(r => (shut ? r.replace(/e/g, 'm') : r))
  if (flash) pal.a = 0xffffff
  if (as === 'svg') {
    // Remote surfaces draw the same pixels as squares, one rect per lit pixel.
    const rects: string[] = []
    px.forEach((gr, y) => {
      for (let c = 0; c < AV_W; c++) {
        const col = pal[grid[gr]![c]!]
        if (col !== undefined) rects.push(`<rect x="${c}" y="${y}" width="1" height="1" fill="#${col.toString(16).padStart(6, '0')}"/>`)
      }
    })
    const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${AV_W} ${px.length}" shape-rendering="crispEdges">${rects.join('')}</svg>`
    CELLS.set(memo, out)
    return out
  }
  // A one-line card's face fills the top half of its cell alone: with both halves lit,
  // the faces of cards on consecutive rows touched and read as one tall avatar.
  const gap = density === 2
  const words = new Uint32Array(AV_W * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < AV_W; c++) {
      const top = pal[grid[px[r * 2]!]![c]!]
      const bot = gap ? undefined : pal[grid[px[r * 2 + 1]!]![c]!]
      const i = (r * AV_W + c) * 3
      if (top === undefined && bot === undefined) words.set([0x20, DEFAULT, DEFAULT], i)
      else if (top === undefined) words.set([0x2584, bot!, DEFAULT], i)
      else words.set([0x2580, top, bot ?? DEFAULT], i)
    }
  }
  const out = (new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }).toBase64()
  CELLS.set(memo, out)
  return out
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
  // A brief that names the worktree or the lane's state folder is surest; one that
  // only names the lane (a reviewer's "lane lx-statements") counts after those.
  let best: HudLane | undefined
  let score = 0
  const text = `${a.hint}\n${a.description}`
  for (const r of rows) {
    const rel = r.worktree.split('/.claude/worktrees/')[1]
    const byPath =
      (r.worktree && a.hint.includes(r.worktree)) || (rel && a.hint.includes(`worktrees/${rel}`)) || a.hint.includes(`/lanes/${r.lane}/`)
    const bare = r.lane.replace(/^lane-/, '')
    const byName = bare.length >= 6 && new RegExp(`(^|[^\\w.-])(lane-)?${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(text)
    const s = byPath ? 1000 + r.worktree.length : byName ? bare.length : 0
    if (s > score) {
      best = r
      score = s
    }
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

function jobCard(E: Els, v: View, j: HudJob, cols: number, underLane = false): RenderChildren {
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
      // Under its lane the lane and worktree go without saying: say what the job does.
      title: underLane ? role : j.lane || j.engine,
      branch: underLane ? '' : (j.cwd.split('/').pop() ?? ''),
      st,
      extra: `${underLane ? '' : `${role}  `}${j.status === 'running' ? dur : `${dur} · ${fmtDur(v.at - (j.endedAt ?? j.startedAt))} ago`}`,
      model: j.model,
      noCtx: true,
      motion: j.status === 'running' ? 'running' : 'still',
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

const SPIN = ['◐', '◓', '◑', '◒']
// One sprite pixel on a remote surface, in CSS pixels: 6 across fills the avatar column.
const SVG_PX = 5

function Avatar(E: Els, v: View, id: string, isMain: boolean, mo: Motion = 'still') {
  const { Box, Text } = E
  if (v.raster && 'Raster' in E) {
    const { Raster } = E as Els & { Raster: ElementConstructor<RasterProps> }
    return (
      <Box width={AV_W} flexShrink={0}>
        <Raster key={`av${v.density}${v.style}${isMain ? v.t.name : ''}-${id}`} columns={AV_W} rows={AV_PIXELS[v.density].length / 2} cells={avatarCells(id, isMain, v.density, v.t, v.style, mo, v.f)} />
      </Box>
    )
  }
  if ('Svg' in E) {
    const { Svg } = E as Els & { Svg: ElementConstructor<SvgProps> }
    const tall = AV_PIXELS[v.density].length
    return (
      <Box width={AV_W} flexShrink={0}>
        <Svg
          key={`svg${v.density}-${id}`}
          source={avatarCells(id, isMain, v.density, v.t, v.style, mo, v.f, 'svg')}
          alt={isMain ? 'This session' : 'Agent avatar'}
          width={AV_W * SVG_PX}
          height={tall * SVG_PX}
        />
      </Box>
    )
  }
  return (
    <Box width={3} flexShrink={0}>
      <Text color={isMain ? accent(v.t) : 'suggestion'}>{mo !== 'still' ? SPIN[(v.f + (hash(id) % 4)) % 4] : isMain ? '✻' : '◆'}</Text>
    </Box>
  )
}

function CtxBar(E: Els, pct: number | undefined, w: number, t: Theme) {
  const { Text } = E
  if (pct === undefined) return <Text dimColor>{'─'.repeat(w)}   –</Text>
  const [on, off] = barText(pct, w)
  const c = pct >= 60 ? pctColor(pct) : t.meters[0]
  return (
    <Text>
      <Text color={c}>{on}</Text>
      <Text dimColor>{off}</Text>
      <Text color={c}> {String(Math.round(pct)).padStart(3)}%</Text>
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
  motion?: Motion
}

function Card(E: Els, v: View, d: CardData, cols: number) {
  const { Box, Text, Button } = E
  const tiny = v.density === 2
  const inner = Math.max(16, cols - AV_W - 3)
  // The bar takes what the name and a short branch leave over, between 4 and 8 cells:
  // a long bar was cutting the name, which matters more than the bar's resolution.
  const barW = tiny ? 0 : Math.max(4, Math.min(8, Math.floor(inner / 5), inner - 6 - d.nick.length - 8))
  // One line still names the agent's own model: a lane's agents needn't share the one
  // its registry row plans, and an external job's engine says more than "ext".
  const model = tiny && d.model ? `${cut(d.model, 14)} ` : ''
  const status = tiny ? `${d.st.icon} ${cut(d.st.label, 10)} ${d.noCtx ? '' : d.pct === undefined ? '  –' : `${String(Math.round(d.pct)).padStart(3)}%`}`.trimEnd() : ''
  const right = model + status
  const left = Math.max(6, inner - (tiny ? right.length + 1 : barW + 6))
  // The name whole, then the branch (up to about half of what's left), then the description.
  const nick = cut(d.nick, Math.max(4, left - 8))
  const free = left - nick.length
  const descNeed = d.title ? d.title.length + 1 : 0
  const branchNeed = d.branch ? d.branch.length + 3 : 0
  const branchW = branchNeed + descNeed <= free ? branchNeed : Math.min(branchNeed, Math.max(Math.floor(free * 0.55), free - descNeed))
  const descW = free - branchW
  const rest = d.title && descW > 2 ? ` ${cut(d.title, descW - 1)}` : ''
  const branch = cut(d.branch, Math.max(2, branchW - 3))
  const label = [<Text bold>{nick}</Text>, <Text>{rest}</Text>, d.branch ? <Text dimColor> ⎇ {branch}</Text> : null]
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
        {Avatar(E, v, d.id, d.isMain, d.motion)}
        <Box flexDirection="row" flexGrow={1} justifyContent="space-between">
          <Box flexShrink={1}>{head}</Box>
          <Text>
            <Text dimColor>{model}</Text>
            <Text color={d.st.color}>{status}</Text>
          </Text>
        </Box>
      </Box>
    )
  }
  return (
    <Box key={`card-${d.id}`} flexDirection="row" gap={1} marginBottom={v.density === 0 ? 1 : 0}>
      {Avatar(E, v, d.id, d.isMain, d.motion)}
      <Box flexDirection="column" flexGrow={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexShrink={1}>{head}</Box>
          {d.noCtx ? <Text dimColor>external</Text> : CtxBar(E, d.pct, barW, v.t)}
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

/** "demo-e: count images" under lane demo-e-assets reads "count images": the lane already says it. */
function withoutLane(desc: string, lane?: string): string {
  const m = /^([\w.-]+):\s+(.+)$/.exec(desc)
  if (!m || !lane) return desc
  const p = m[1]!.toLowerCase()
  const l = lane.toLowerCase()
  return l === p || l.startsWith(`${p}-`) || p.startsWith(`${l}-`) ? m[2]! : desc
}

function agentCard(E: Els, v: View, a: HudAgent, cols: number, $: EngineInterface, branch?: string, lane?: string): RenderChildren {
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
      title: withoutLane(a.description, lane) || (a.name ? a.type : ''),
      branch: branch ?? a.type,
      st,
      extra: bits.join('  '),
      model: relay ?? prettyModel(a.model),
      pct,
      noCtx: !!relay,
      motion: !LIVE.has(a.status) ? 'still' : a.activity === 'idle' ? 'running' : a.activity,
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
    {
      id: 'main',
      isMain: true,
      nick: 'This session',
      title: '',
      branch,
      st,
      extra: bits.join('  '),
      model: prettyModel(v.u?.model),
      pct: v.u?.ctxPercent,
      motion: !v.m.working ? 'still' : v.m.activity === 'idle' ? 'running' : v.m.activity,
    },
    cols,
  )
}

const LIMIT_LABEL: Record<string, string> = { seven_day_opus: 'Opus 7d', seven_day_sonnet: 'Sonnet 7d', spend_limit: 'Spend' }

// ── The band above the prompt: context and plan limits, with "more" ──────

const LIMIT_SPAN: Record<string, number> = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 86400_000,
  seven_day_opus: 7 * 86400_000,
  seven_day_sonnet: 7 * 86400_000,
}

type Pace = { resetIn?: number; hitAt?: number }

function pace(l: HudLimit, at: number): Pace {
  const resetAt = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  if (!Number.isFinite(resetAt)) return {}
  const resetIn = resetAt - at
  const span = LIMIT_SPAN[l.kind]
  if (span === undefined) return { resetIn }
  const elapsed = Math.max(0, span - resetIn)
  // Too early in the window, or nothing used yet: no rate to go by.
  if (elapsed < span * 0.03 || l.percentUsed <= 0) return { resetIn }
  const rate = l.percentUsed / elapsed
  return { resetIn, hitAt: at + (100 - l.percentUsed) / rate }
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A meter's colour, a shade darker toward the bar's start (`k` 0) for a gentle ramp. */
function ramp(color: string, k: number): string {
  if (!color.startsWith('#')) return color
  const c = rgb(color)
  const f = 0.7 + 0.3 * Math.max(0, Math.min(1, k))
  return `#${c.map(x => Math.round(x * f).toString(16).padStart(2, '0')).join('')}`
}

type Meter = 0 | 1 | 2

/** A bar in its meter's colour with 1/8-cell precision; amber, then red, as it fills. */
function Bar(E: Els, pct: number | undefined, w: number, t: Theme, meter: Meter) {
  const { Text } = E
  const p = Math.max(0, Math.min(100, pct ?? 0))
  const exact = (p / 100) * w
  const full = Math.floor(exact)
  const part = EIGHTHS[Math.floor((exact - full) * 8)] ?? ''
  const hot = p >= 85 ? 'error' : p >= 60 ? 'warning' : undefined
  const cells: RenderChildren[] = []
  for (let i = 0; i < full; i++) cells.push(<Text color={hot ?? ramp(t.meters[meter], w <= 1 ? 1 : i / (w - 1))}>█</Text>)
  if (part) cells.push(<Text color={hot ?? ramp(t.meters[meter], full / Math.max(1, w - 1))}>{part}</Text>)
  const rest = w - full - (part ? 1 : 0)
  return (
    <Text>
      {cells}
      {rest > 0 ? <Text dimColor>{'░'.repeat(rest)}</Text> : null}
    </Text>
  )
}

function Pct(E: Els, pct: number | undefined) {
  const { Text } = E
  return (
    <Text bold color={pct === undefined ? 'subtle' : pctColor(pct)}>
      {(pct === undefined ? '–' : `${Math.round(pct)}%`).padStart(4)}
    </Text>
  )
}

function resetText(l: HudLimit | undefined, at: number, withDay: boolean): string {
  const t = l?.resetsAt ? Date.parse(l.resetsAt) : NaN
  return Number.isFinite(t) ? `↻ ${fmtDur(t - at)} · ${fmtClock(t, withDay)}` : ''
}

function limitsOf(v: View) {
  const lim = v.u?.limits ?? []
  return {
    five: lim.find(l => l.kind === 'five_hour'),
    week: lim.find(l => l.kind === 'seven_day'),
    others: lim.filter(l => l.kind !== 'five_hour' && l.kind !== 'seven_day'),
  }
}

function UsageButtons(E: Els, v: View, $: EngineInterface, cols: number, where: HudPlacement) {
  const { Box, Button } = E
  const isOpen = v.open
  return (
    <Box flexDirection="row" gap={2} flexShrink={0}>
      <Button key="hud-more" plain label={isOpen ? '▴ less' : '▾ more'} onPress={() => void toggleBand($, cols)} />
      <Button key="hud-theme" plain label={`🎨 ${v.t.name}`} onPress={() => void nextTheme($)} />
      {where === 'panel' || cols >= 90 ? <Button key="hud-avatars" plain label={`☺ ${v.style}`} onPress={() => void nextAvatars($)} /> : null}
      {where === 'band' ? <Button key="hud-panel" plain label="◫ panel" onPress={() => void togglePanel($)} /> : null}
      <Button key="hud-move" plain label={where === 'panel' ? '⇠ to chat' : '⇢ to panel'} onPress={() => void movePlacement($)} />
    </Box>
  )
}

function compactBand(E: Els, v: View, cols: number, $: EngineInterface) {
  const { Box, Text } = E
  const { five, week } = limitsOf(v)
  const barW = cols >= 140 ? 12 : cols >= 110 ? 9 : cols >= 90 ? 6 : 4
  const gauge = (label: string, pct: number | undefined, suffix: string, meter: Meter) => (
    <Text wrap="truncate-end">
      <Text bold color={v.t.meters[meter]}>
        {label}{' '}
      </Text>
      {Bar(E, pct, barW, v.t, meter)}
      {Pct(E, pct)}
      {suffix ? <Text dimColor> {suffix}</Text> : null}
    </Text>
  )
  const reset = (l?: HudLimit) => {
    const t = l?.resetsAt ? Date.parse(l.resetsAt) : NaN
    return Number.isFinite(t) && cols >= 100 ? `↻ ${fmtDur(t - v.at)}` : ''
  }
  const ctx = v.u?.ctxTokens !== undefined && cols >= 100 ? `${fmtTokens(v.u.ctxTokens)}/${fmtTokens(v.u.ctxWindow)}` : ''
  return (
    <Box flexDirection="row" justifyContent="space-between" gap={2}>
      <Box flexDirection="row" gap={3} flexShrink={1}>
        {gauge('CTX', v.u?.ctxPercent, ctx, 0)}
        {gauge('5H', five?.percentUsed, reset(five), 1)}
        {cols >= 80 ? gauge('7D', week?.percentUsed, reset(week), 2) : null}
      </Box>
      {UsageButtons(E, v, $, cols, 'band')}
    </Box>
  )
}

// Where use lands if it keeps the rate it has had since the window opened.
function PaceLine(E: Els, l: HudLimit, at: number, indent: number): RenderChildren | null {
  const { Text } = E
  const p = pace(l, at)
  if (p.resetIn === undefined || p.hitAt === undefined) return null
  const resetAt = at + p.resetIn
  return (
    <Text key={`pace-${l.kind}`} wrap="truncate-end">
      <Text dimColor>{' '.repeat(indent)}</Text>
      {p.hitAt < resetAt ? (
        <Text bold color={p.hitAt - at < 3600_000 ? 'error' : 'warning'}>
          ⚠ At this pace you'll run out by {whenText(p.hitAt, at)}, {fmtDur(resetAt - p.hitAt)} before it resets
        </Text>
      ) : (
        <Text color="success">✓ Resets before you'd run out</Text>
      )}
    </Text>
  )
}

/** A time alone when it falls today, else with its date. */
function whenText(t: number, at: number): string {
  return fmtClock(t, new Date(t).toDateString() !== new Date(at).toDateString())
}

/**
 * The usage figures, one row per entry so a caller can count them: the three
 * bars, or with "more" open the context breakdown and the limits with pace.
 */
function usageLines(E: Els, v: View, cols: number, where: HudPlacement): RenderChildren[] {
  const { Text } = E
  const { five, week, others } = limitsOf(v)
  const labelW = 9
  const indent = v.open ? 2 : 0
  const row = (label: string, pct: number | undefined, right: string, meter: Meter) => {
    const barW = Math.max(4, Math.min(32, cols - indent - labelW - 4 - (right ? right.length + 2 : 0)))
    return (
      <Text key={`use-${label}`} wrap="truncate-end">
        <Text>{' '.repeat(indent)}</Text>
        <Text bold color={v.t.meters[meter]}>
          {label.padEnd(labelW)}
        </Text>
        {Bar(E, pct, barW, v.t, meter)}
        {Pct(E, pct)}
        {right ? <Text dimColor>  {right}</Text> : null}
      </Text>
    )
  }
  const head = (label: string) => (
    <Text key={`head-${label}`} bold color={accent(v.t)}>
      ◆ {label}
    </Text>
  )
  const tokens = v.u?.ctxTokens !== undefined ? `${fmtTokens(v.u.ctxTokens)}/${fmtTokens(v.u.ctxWindow)}` : ''
  const limits: RenderChildren[] = []
  const limit = (label: string, l: HudLimit | undefined, withDay: boolean) => {
    limits.push(row(label, l?.percentUsed, resetText(l, v.at, withDay), l?.kind === 'five_hour' || label === '5-hour' ? 1 : 2))
    const pl = v.open && l ? PaceLine(E, l, v.at, indent + labelW) : null
    if (pl) limits.push(pl)
  }
  limit('5-hour', five, false)
  limit('Weekly', week, true)
  for (const l of others) limit(LIMIT_LABEL[l.kind] ?? l.kind, l, true)
  const none = !five && !week ? [<Text dimColor>{' '.repeat(indent)}Plan limits arrive with the next response.</Text>] : []
  if (!v.open) return [row('Context', v.u?.ctxPercent, tokens, 0), ...limits, ...none]

  const cats = (v.b?.categories ?? []).filter(c => c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const catMax = Math.max(1, ...cats.map(c => c.tokens))
  const catW = Math.max(6, Math.min(14, cols - 20))
  const compact = v.b?.autoCompactAt ? `autocompact at ${fmtTokens(v.b.autoCompactAt)}` : v.b && !v.b.isAutoCompact ? 'autocompact off' : ''
  const ctxRight = [tokens, compact].filter(Boolean).join(' · ')
  return [
    ...(where === 'panel' ? [head('CONTEXT WINDOW')] : []),
    row('Context', v.u?.ctxPercent, cols >= 60 ? ctxRight : tokens, 0),
    ...(cols < 60 && compact ? [<Text key="compact-at" dimColor>{' '.repeat(indent + labelW)}{compact}</Text>] : []),
    ...(cats.length === 0 ? [<Text dimColor>{' '.repeat(indent + 2)}Measuring what fills the window…</Text>] : []),
    ...cats.map((c, i) => {
      const n = Math.max(1, Math.round((c.tokens / catMax) * catW))
      return (
        <Text key={`cat-${c.name}`} wrap="truncate-end">
          <Text>{' '.repeat(indent + 2)}</Text>
          <Text color={ramp(v.t.meters[0], 1 - (i % 3) / 3)}>{'▮'.repeat(n)}</Text>
          <Text dimColor>{'▮'.repeat(catW - n)}</Text>
          <Text> {fmtTokens(c.tokens).padStart(5)} </Text>
          <Text dimColor>{c.name}</Text>
        </Text>
      )
    }),
    head('PLAN LIMITS'),
    ...none,
    ...limits,
  ]
}

function expandedBand(E: Els, v: View, cols: number, $: EngineInterface) {
  const { Box, Text } = E
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={accent(v.t)}>
          ◆ CONTEXT WINDOW
        </Text>
        {UsageButtons(E, v, $, cols, 'band')}
      </Box>
      {usageLines(E, v, cols, 'band')}
    </Box>
  )
}

/**
 * The rule over the usage lines. The terminal draws it as box characters; the
 * desktop app sets text in its own font, where a run sized in columns overflows
 * the panel (wrapping, or an ellipsis), so there it is a hairline as wide as the panel.
 */
function FooterRule(E: Els, cols: number): RenderChildren {
  if ('Svg' in E) {
    const { Svg } = E as Els & { Svg: ElementConstructor<SvgProps> }
    return (
      <Svg
        key="hud-rule"
        source={'<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="9" viewBox="0 0 10000 9" preserveAspectRatio="none"><rect x="0" y="4" width="10000" height="1" fill="#888" fill-opacity="0.5"/></svg>'}
        alt=""
        height={9}
      />
    )
  }
  const { Text } = E
  return <Text dimColor>{'─'.repeat(cols)}</Text>
}

/** The panel's foot: a rule, the usage lines, then the settings row. */
function panelFooter(E: Els, v: View, cols: number, $: EngineInterface): { node: RenderChildren; rows: number } {
  const { Box } = E
  const lines = usageLines(E, v, cols, 'panel')
  return {
    rows: lines.length + 2,
    node: (
      <Box key="hud-foot" flexDirection="column" flexShrink={0}>
        {FooterRule(E, cols)}
        {lines}
        {UsageButtons(E, v, $, cols, 'panel')}
      </Box>
    ),
  }
}

async function movePlacement($: EngineInterface) {
  const to = await update($, placement, p => (p === 'panel' ? 'band' : 'panel'))
  await $.store.set('placement', to).catch(() => undefined)
  if (to === 'panel') await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
}

async function togglePanel($: EngineInterface) {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane?.isShown) await $.ui.close({ id: PANE })
  else await $.ui.open({ id: PANE, title: TITLE })
}

async function refreshBreakdown($: EngineInterface, columns: number) {
  const u = await $.session.usage({ breakdown: 'summary', columns })
  const b = u.context.breakdown
  if (!b) return
  const next: HudBreakdown = {
    categories: b.categories.filter(c => !c.isDeferred && c.kind === 'used').map(c => ({ name: c.name, tokens: c.tokens })),
    autoCompactAt: b.autoCompactThreshold,
    isAutoCompact: b.isAutoCompactEnabled,
  }
  await update($, breakdown, prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
}

async function toggleBand($: EngineInterface, columns = 100) {
  const open = await update($, expanded, x => !x)
  if (open) await refreshBreakdown($, columns).catch(() => undefined)
}

function Header(E: Els, v: View, cols: number, version: string | undefined) {
  const { Box, Text } = E
  const running = v.ag.filter(a => LIVE.has(a.status)).length + v.jobs.filter(j => j.status === 'running' && !isShadowed(j, v.ag)).length
  const label = version ? `Agents HUD v${version}` : 'Agents HUD'
  const count = v.isLanes
    ? `${v.l.repo?.split('/').pop() ?? '?'} · ${v.l.rows.length} lanes · ${running} running`
    : `${v.ag.length} · ${running} running`
  return (
    <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
      <Text bold color={accent(v.t)}>
        {label}
      </Text>
      <Text dimColor>{cut(count, Math.max(4, cols - label.length - 2))}</Text>
    </Box>
  )
}

type Item = { node: RenderChildren; rows: number }

/** A lane's card, set in from the lane's header with a rail down its left that ties it to the lane. */
function Indent(E: Els, key: string, node: RenderChildren, rows: number, live: boolean): RenderChildren {
  const { Box, Text } = E
  return (
    <Box key={key} flexDirection="row">
      <Box flexDirection="column" width={2} flexShrink={0}>
        {Array.from({ length: rows }, (_, i) => (
          <Text key={`rail-${i}`} color={live ? 'success' : 'subtle'}>
            {'│'}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {node}
      </Box>
    </Box>
  )
}

/** Running agents first, then the most recently active. */
function sortAgents(list: HudAgent[]): HudAgent[] {
  return [...list].sort((a, b) => Number(LIVE.has(b.status)) - Number(LIVE.has(a.status)) || b.updatedAt - a.updatedAt)
}

function sortJobs(list: HudJob[]): HudJob[] {
  const at = (j: HudJob) => j.endedAt ?? j.startedAt
  return [...list].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || at(b) - at(a))
}

function laneItems(E: Els, v: View, cols: number, $: EngineInterface): Item[] {
  const { Box, Button, Text } = E
  const card = CARD_ROWS[v.density]
  const groups = new Map<string, HudAgent[]>()
  const loose: HudAgent[] = []
  for (const a of v.ag) {
    const r = laneOf(a, v.l.rows)
    if (r) groups.set(r.lane, [...(groups.get(r.lane) ?? []), a])
    else loose.push(a)
  }
  const out: Item[] = []
  // Agents this session started itself, outside any lane, always come first.
  if (loose.length) {
    out.push({ rows: 1, node: <Text bold dimColor>Direct agents</Text> })
    for (const a of sortAgents(loose)) out.push({ rows: card, node: agentCard(E, v, a, cols, $) })
    if (v.density !== 0) out.push({ rows: 1, node: <Text key="gap-direct"> </Text> })
    out.push({ rows: 1, node: <Text bold dimColor>Lanes</Text> })
  }
  if (v.l.rows.length === 0) out.push({ node: <Text dimColor>No lanes running</Text>, rows: 1 })
  // Lanes with something running first, then lanes whose agents or jobs have
  // finished (latest first); lanes with nothing in this session fold into one row.
  const info = v.l.rows.map((r, i) => {
    const list = sortAgents(groups.get(r.lane) ?? [])
    const laneJobs = sortJobs(v.jobs.filter(j => jobLane(j, v.l.rows) === r && !isShadowed(j, v.ag)))
    const live = list.filter(a => LIVE.has(a.status)).length + laneJobs.filter(j => j.status === 'running').length
    const last = Math.max(0, ...list.map(a => a.updatedAt), ...laneJobs.map(j => j.endedAt ?? j.startedAt))
    return { r, i, list, laneJobs, live, last }
  })
  const busy = info.filter(x => x.list.length || x.laneJobs.length).sort((a, b) => b.live - a.live || b.last - a.last)
  const idle = info.filter(x => !x.list.length && !x.laneJobs.length)
  const shown = v.showIdle ? [...busy, ...idle] : busy
  for (const { r, list, laneJobs, live } of shown) {
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
    for (const a of list) out.push({ rows: card, node: Indent(E, `in-${a.id}`, agentCard(E, v, a, cols - 2, $, '', r.lane), card, live > 0) })
    for (const j of laneJobs) out.push({ rows: card, node: Indent(E, `in-${j.id}`, jobCard(E, v, j, cols - 2, true), card, live > 0) })
    if (v.density !== 0) out.push({ rows: 1, node: <Text key={`gap-${r.lane}`}> </Text> })
  }
  if (idle.length) {
    const label = v.showIdle
      ? `▾ hide the ${idle.length} lanes with nothing here`
      : `▸ ${idle.length} ${busy.length ? 'more ' : ''}lanes with nothing running here`
    out.push({
      rows: 2,
      node: (
        <Box key="idle-lanes" marginBottom={1}>
          <Button key="toggle-idle" plain onPress={() => void update($, showIdle, x => !x)}>
            <Text dimColor>{label}</Text>
          </Button>
        </Box>
      ),
    })
  }
  const looseJobs = v.jobs.filter(j => !jobLane(j, v.l.rows) && !isShadowed(j, v.ag))
  if (looseJobs.length) {
    out.push({ rows: 1, node: <Text bold dimColor>External jobs</Text> })
    for (const j of sortJobs(looseJobs)) out.push({ rows: card, node: jobCard(E, v, j, cols) })
  }
  return out
}

function agentItems(E: Els, v: View, cols: number, $: EngineInterface): Item[] {
  const { Text } = E
  const card = CARD_ROWS[v.density]
  const ext = sortJobs(v.jobs.filter(j => !isShadowed(j, v.ag)))
  return [
    ...sortAgents(v.ag).map(a => ({ rows: card, node: agentCard(E, v, a, cols, $, laneOf(a, v.l.rows)?.lane) })),
    ...(ext.length ? [{ rows: 1, node: <Text bold dimColor>External jobs</Text> }] : []),
    ...ext.map(j => ({ rows: card, node: jobCard(E, v, j, cols) })),
  ]
}

async function view($: EngineInterface, surface: string): Promise<View> {
  const [ag, m, u, l, inv, md, at, jb, b, ti, st, op, wh, si] = await Promise.all([
    read($, agents),
    read($, main),
    read($, usage),
    read($, lanes),
    read($, lanesInvoked),
    read($, mode),
    read($, now),
    read($, jobs),
    read($, breakdown),
    read($, theme),
    read($, avatars),
    read($, expanded),
    read($, placement),
    read($, showIdle),
  ])
  const isLanes = md === 'lanes' || (md === 'auto' && inv)
  const nick = assignNames([
    ...ag.map(a => ({ id: a.id, at: a.startedAt, fixed: a.name || undefined })),
    ...jb.map(j => ({ id: j.id, at: j.startedAt })),
  ])
  return { ag, m, u, b, l, jobs: jb, isLanes, at, raster: surface === 'terminal', nick, t: themeOf(ti), style: st, open: op, where: wh, showIdle: si, f: 0, density: 0 }
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
  let animator: { cancel: () => void } | undefined
  // Opened unasked at session start, a pane is only placed from 144 columns, which
  // a desktop window measured in code-font cells seldom reaches. A prompt counts as
  // asking, so on a remote surface the first one opens it: unless the person closed it.
  let closedByPerson = false
  let triedOnPrompt = false
  let ticks = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'agents-hud',
      description: 'Agents HUD: open the panel. Args: lanes | agents | auto (grouping), more (context breakdown), theme [name], avatars [style], panel | chat (where usage shows), motion [on|off]',
    })
    const saved = await $.store.get('theme').catch(() => undefined)
    if (typeof saved === 'number') await update($, theme, () => saved)
    const style = await $.store.get('avatars').catch(() => undefined)
    if (typeof style === 'string' && AVATARS[style]) await update($, avatars, () => style)
    const where = await $.store.get('placement').catch(() => undefined)
    if (where === 'panel' || where === 'band') await update($, placement, () => where)
    const moves = await $.store.get('motion').catch(() => undefined)
    if (typeof moves === 'boolean') await update($, motion, () => moves)
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

    // The avatars' frames: advanced only while something works, so a resting panel never redraws.
    animator?.cancel()
    animator = $.clock.every(ANIM_MS, () => {
      void (async () => {
        const [ag, m, jb, moving] = await Promise.all([read($, agents), read($, main), read($, jobs), read($, motion)])
        if (moving && (m.working || ag.some(a => LIVE.has(a.status)) || jb.some(j => j.status === 'running'))) {
          await update($, frame, f => (f + 1) % 10_000)
        }
      })().catch(() => undefined)
    })
    return result
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    animator?.cancel()
    return next(e)
  })

  on('command.run', { command: 'agents-hud' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'more' || arg === 'less') {
      await toggleBand($)
      return { text: (await read($, expanded)) ? 'Context breakdown shown above the prompt.' : 'Context breakdown hidden.' }
    }
    if (arg === 'theme' || arg.startsWith('theme ')) {
      const t = await nextTheme($, arg.slice(5).trim() || undefined)
      return { text: `Agents HUD theme: ${t.name}. Themes: ${THEMES.map(x => x.name).join(', ')}.` }
    }
    if (arg === 'motion' || arg === 'motion on' || arg === 'motion off') {
      const moving = await update($, motion, x => (arg === 'motion' ? !x : arg === 'motion on'))
      await $.store.set('motion', moving).catch(() => undefined)
      return { text: moving ? 'Avatars move while their agent works.' : 'Avatars stay still.' }
    }
    if (arg === 'panel' || arg === 'chat' || arg === 'band') {
      const want: HudPlacement = arg === 'panel' ? 'panel' : 'band'
      if ((await read($, placement)) !== want) await movePlacement($)
      return { text: want === 'panel' ? 'Usage shows at the bottom of the side panel.' : 'Usage shows above the prompt.' }
    }
    if (arg === 'avatars' || arg.startsWith('avatars ')) {
      const st = await nextAvatars($, arg.slice(7).trim() || undefined)
      return { text: `Agents HUD avatars: ${st}. Styles: ${AVATAR_STYLES.join(', ')}.` }
    }
    if (arg === 'lanes' || arg === 'agents' || arg === 'auto') await update($, mode, () => arg as HudMode)
    closedByPerson = false
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

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') closedByPerson = true
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!triedOnPrompt && !closedByPerson) {
      triedOnPrompt = true
      const remote = (await $.session.surfaces()).some(x => x !== 'terminal')
      const pane = (await $.ui.panes()).find(p => p.id === PANE)
      if (remote && !pane?.isPlaced) await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    }
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
    if (e.changed.includes('context') && (await read($, expanded))) await refreshBreakdown($, 100).catch(() => undefined)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, placement)) !== 'band') return next(e)
    const E = $.ui.resolve(e)
    const v = await view($, e.surface)
    const cols = Math.max(40, e.props.bodyColumns)
    return v.open ? expandedBand(E, v, cols, $) : compactBand(E, v, cols, $)
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
    const [seen, moving, version] = await Promise.all([view($, e.surface), read($, motion), pluginVersion($)])
    const base = { ...seen, f: moving ? await read($, frame) : 0 }
    // One column of gutter off the divider the engine draws against the chat.
    const cols = Math.max(24, e.props.bodyColumns - GUTTER)
    const branch = base.isLanes ? 'orchestrator' : (base.l.repo?.split('/').pop() ?? 'main')
    const budget = e.props.scroll.bodyRows
    let v = base
    let items: Item[] = []
    let room = 0
    const foot = base.where === 'panel' ? panelFooter(E, base, cols, $) : undefined
    for (const density of [0, 1, 2] as const) {
      v = { ...base, density }
      items = base.isLanes ? laneItems(E, v, cols, $) : agentItems(E, v, cols, $)
      room = budget - 2 - CARD_ROWS[density] - (foot?.rows ?? 0)
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
      // A docked pane's body doesn't size its tree, so "100%" would collapse to the
      // cards' height: fill its rows outright so the usage sits on the bottom edge.
      <Box flexDirection="column" paddingLeft={GUTTER} height={e.props.placement === 'dock' ? budget : undefined}>
        {Header(E, v, cols, version)}
        {mainCard(E, v, cols, branch)}
        {paging.active ? more(above, -1) : null}
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {body.map(i => i.node)}
        </Box>
        {paging.active ? more(below, 1) : null}
        {foot?.node}
      </Box>
    )
  })
}
