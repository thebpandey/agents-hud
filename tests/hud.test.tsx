import { expect, mock, test } from 'claude-code/testing'

import { cardWindow, scrollStep } from '../hooks/register'

const PANE = {
  plugin: 'agents-hud',
  component: 'Pane',
  requestId: 'agents-hud',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 56,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'agents-hud',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

/** How many times the mod asked for its pane; reset per test. */
const opened = { count: 0 }

const REPO = '/home/me/dev/proj'
// Lanes registered earlier, with nothing in this session; listed before the live one.
const IDLE_FIRST = ['z1-old', 'z2-old', 'z3-old']
const IDLE = IDLE_FIRST.map(l => `${l}\tDeepSeek\told task\t.claude/worktrees/lane-${l}\tdeepseek\n`).join('')
const WT = `${REPO}/.claude/worktrees/lane-a1-auth`

// Each hook here stands for the engine.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], crowd = 0) {
  const clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'agents-hud' } }))
  on('ui.open', () => (opened.count++, { value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: REPO }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', (_, e) => ({
    value: {
      startedAt: 0,
      context: {
        tokens: 50_000,
        window: 200_000,
        percent: 25,
        ...((e as { breakdown?: string }).breakdown
          ? {
              breakdown: {
                categories: [
                  { name: 'Messages', tokens: 30_000, kind: 'used' },
                  { name: 'System tools', tokens: 12_000, kind: 'used' },
                  { name: 'Free space', tokens: 140_000, kind: 'free' },
                ],
                totalTokens: 50_000,
                maxTokens: 200_000,
                rawMaxTokens: 200_000,
                percentage: 25,
                autoCompactThreshold: 187_000,
                isAutoCompactEnabled: true,
              },
            }
          : {}),
      },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 14, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), source: 'api' },
        { kind: 'seven_day', percentUsed: 22, resetsAt: new Date(Date.now() + 3 * 86400_000).toISOString(), source: 'api' },
      ],
    },
  }))
  on('agent.list', () => ({
    value: crowd
      ? Array.from({ length: crowd }, (_, i) => ({ id: `c${i}`, description: `task ${i}`, type: 'sonnet-lane', status: 'running' }))
      : [
      { id: 'a1', description: 'a1-auth: auth refactor', type: 'sonnet-lane', status: 'running', name: 'auth-coder' },
      { id: 'a2', description: 'look for usages', type: 'Explore', status: 'completed' },
      { id: 'a3', description: 'docs pass', type: 'glm', status: 'running' },
      { id: 'a4', description: 'Review lane a1-auth', type: 'lane-reviewer', status: 'running' },
    ],
  }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', (_, e) => {
    const isScan = (e as unknown as { argv: string[] }).argv[0] === 'bash'
    const t = Math.floor(Date.now() / 1000)
    const job = ['model-relay.abc123', 'deepseek', '', '', WT, '', '', String(t - 60), '', '1'].join('\t')
    return { value: { exitCode: 0, stdout: isScan ? `${job}\n` : `${REPO}/.git\n`, stderr: '' } }
  })
  on('fs.read', (_, e) => e.path.endsWith('/.claude-plugin/plugin.json') ? { value: '{"name":"agents-hud","version":"9.8.7"}' } : ({ value: `lane\tagent\ttask\tworktree\trelay\n${IDLE}a1-auth\tSonnet 5.5 (T2)\tAuth refactor\t.claude/worktrees/lane-a1-auth\tagent\n` }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('tool.call', () => ({ result: {} }))
  return clock
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`agents view with names (${surface})`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: REPO, surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /auth-coder/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /This session/ })).toBeTruthy()
    // The header names the mod and the version its manifest declares, so a stale install is visible at a glance.
    expect(await ui.find({ type: 'Text', text: /^Agents HUD v9\.8\.7$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /GLM 5\.3 Flash/ })).toBeTruthy()
    // An agent with no name of its own gets a robot name before its description.
    expect(await ui.find({ type: 'Text', text: /^[A-Z][a-z]+$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /look for/ })).toBeTruthy()
    await ui.unmount()
  })

  test(`usage at the panel's foot, its breakdown, then moved above the prompt (${surface})`, async ($, on) => {
    engine(on)
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => ({ value: undefined }))
    await $.session.start({ cwd: REPO, surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Context.*25%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /5-hour.*14%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Weekly.*22%/ })).toBeTruthy()
    // Each meter wears its own colour: the labels of the three bars differ.
    const labels = await Promise.all(['Context', '5-hour', 'Weekly'].map(l => ui.find({ type: 'Text', text: new RegExp(`^${l} +$`) })))
    expect(new Set(labels.map(x => x?.props.color)).size).toBe(3)

    await ui.press({ key: 'hud-more' })
    expect(await ui.find({ type: 'Text', text: /CONTEXT WINDOW/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /30k Messages/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /autocompact at 187k/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Free space/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /Resets before you'd run out/ })).toBeTruthy()

    await ui.press({ key: 'hud-avatars' })
    expect(await ui.find({ type: 'Button', label: /cats/ })).toBeTruthy()
    await ui.press({ key: 'hud-theme' })
    expect(await ui.find({ type: 'Button', label: /Ember/ })).toBeTruthy()

    await ui.press({ key: 'hud-move' })
    expect(await ui.find({ type: 'Text', text: /5-hour.*14%/ })).toBeFalsy()
    await ui.unmount()
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /CONTEXT WINDOW/ })).toBeTruthy()
    await band.press({ key: 'hud-more' })
    expect(await band.find({ type: 'Text', text: /CTX.*25%/ })).toBeTruthy()
    expect(await band.find({ type: 'Text', text: /7D.*22%/ })).toBeTruthy()
    await band.unmount()
  })

  test(`a crowded panel stops at two-line cards and scrolls, with no paging rows (${surface})`, async ($, on) => {
    engine(on, 30)
    await $.session.start({ cwd: REPO, surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 30 } } })

    expect(await ui.find({ type: 'Text', text: /task 0/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /task 29/ })).toBeFalsy()
    // Paging rows are gone: the list scrolls by the wheel and keys.
    expect(await ui.find({ type: 'Text', text: /more (below|above)/ })).toBeFalsy()
    // Even crowded, each card keeps its status on a second line beside the name's.
    expect(await ui.find({ type: 'Text', text: /● Working/ })).toBeTruthy()
    // The card cut by the window's bottom edge shows its rows inside, clipped.
    expect((await ui.findAll({ type: 'Box' })).some(b => /^clip-\d+$/.test(String(b.key)))).toBe(true)
    await ui.unmount()
  })

  test(`lanes view groups an agent under its lane (${surface})`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: REPO, surface, isInteractive: true })
    await $.agent.spawn({ prompt: `Work in ${WT}. Follow the brief.`, description: 'auth refactor', subagentType: 'sonnet-lane' })
    await $.tool.call({ tool: 'Skill', skill: 'lanes' })
    const ui = await $.ui.mount({ ...PANE, surface })
    // Avatars: half-block pixels on the terminal, SVG pixels on desktop.
    expect(await ui.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeTruthy()

    expect(await ui.find({ type: 'Text', text: /proj · \d+ lanes/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /a1-auth/ })).toBeTruthy()
    // Under its lane a card names the agent and its task, not the lane or worktree again.
    expect(await ui.find({ type: 'Text', text: /⎇ lane-a1/ })).toBeFalsy()
    // A reviewer whose brief names only the lane is grouped under it too.
    const order = (await ui.findAll({ type: 'Text' })).map(x => x.text)
    const at = (re: RegExp) => order.findIndex(x => re.test(x))
    const reviewAt = at(/^ Review/)
    const laneAt = at(/^ a1-auth$/)
    expect(reviewAt).toBeGreaterThan(laneAt)
    // Agents the session started outside any lane come first, above every lane.
    const directAt = at(/^Direct agents$/)
    expect(directAt).toBeGreaterThan(-1)
    expect(at(/^ docs pass/)).toBeGreaterThan(directAt)
    expect(at(/^ docs pass/)).toBeLessThan(laneAt)
    expect(at(/^Lanes$/)).toBeLessThan(laneAt)
    expect(await ui.find({ type: 'Text', text: /DeepSeek V4\.1 Flash/ })).toBeTruthy()
    // Under its own lane, an agent's description drops the lane-name prefix.
    expect(await ui.find({ type: 'Text', text: /^ auth r/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /a1-auth: auth/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /relay/ })).toBeTruthy()
    // Registered earlier but empty here: folded into one row after the live lane.
    expect(await ui.find({ type: 'Text', text: /z1-old/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /3 more lanes with nothing running here/ })).toBeTruthy()
    await ui.press({ key: 'toggle-idle' })
    const names = (await ui.findAll({ type: 'Text', text: /^ (a1-auth|z1-old)$/ })).map(x => x.text.trim())
    expect(names).toEqual(['a1-auth', 'z1-old'])
    await ui.unmount()
  })
}

test("a working agent's avatar moves; a finished one stays still", async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const seen = { a1: new Set<unknown>(), a2: new Set<unknown>() }
  for (let i = 0; i < 6; i++) {
    for (const id of ['a1', 'a2'] as const) seen[id].add((await ui.find({ key: `av0robots-${id}` }))?.props.cells)
    await clock.advance(450)
  }
  expect(seen.a1.size).toBeGreaterThan(1)
  expect(seen.a2.size).toBe(1)
  await ui.unmount()
})

test('on desktop the first prompt opens the panel, once', async ($, on) => {
  engine(on)
  on('ui.panes', () => ({ value: [{ id: 'agents-hud', title: 'Agents', isShown: false, isFocused: false, isPlaced: false }] }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: REPO, surface: 'desktop', isInteractive: true })
  const atStart = opened.count
  await $.prompt.submit({ text: 'hello' })
  expect(opened.count).toBe(atStart + 1)
  await $.prompt.submit({ text: 'again' })
  expect(opened.count).toBe(atStart + 1)
})

test("the band's ◫ panel button toggles the side panel", async ($, on) => {
  engine(on)
  const shown = { now: true }
  const closed: string[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [{ id: 'agents-hud', title: 'Agents', isShown: shown.now, isFocused: false, isPlaced: true }] }))
  on('ui.close', (_, e) => (closed.push((e as { id: string }).id), { value: undefined }))
  await $.session.start({ cwd: REPO, surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'hud-move' })
  await pane.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await band.press({ key: 'hud-panel' })
  expect(closed).toEqual(['agents-hud'])

  shown.now = false
  const before = opened.count
  await band.press({ key: 'hud-panel' })
  expect(opened.count).toBe(before + 1)
  expect(closed).toEqual(['agents-hud'])
  await band.unmount()
})

test('a crowded terminal panel keeps two-row avatars instead of flattening them to one', async ($, on) => {
  engine(on, 30)
  await $.session.start({ cwd: REPO, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 30 } } })
  const avs = (await ui.findAll({ type: 'Raster' })).filter(x => /-c\d+$/.test(String(x.key)))
  expect(avs.length).toBeGreaterThan(0)
  for (const av of avs) expect(av.props.rows).toBe(2)
  await ui.unmount()
})

test('the window moves a row per wheel tick and cuts the edge cards, so scrolling is smooth', () => {
  // Three two-row cards and a lane header: rows 0-1, 2-3, 4, 5-6.
  const rows = [2, 2, 1, 2]
  expect(cardWindow(rows, 0, 4)).toEqual([{ index: 0, cutTop: 0, shown: 2 }, { index: 1, cutTop: 0, shown: 2 }])
  // One row down: the first card shows its bottom row only, the header comes in whole.
  expect(cardWindow(rows, 1, 4)).toEqual([{ index: 0, cutTop: 1, shown: 1 }, { index: 1, cutTop: 0, shown: 2 }, { index: 2, cutTop: 0, shown: 1 }])
  // A card cut by the bottom edge shows its top row.
  expect(cardWindow(rows, 2, 4)).toEqual([{ index: 1, cutTop: 0, shown: 2 }, { index: 2, cutTop: 0, shown: 1 }, { index: 3, cutTop: 0, shown: 1 }])
  // Every row of the window is filled, at every offset.
  for (let o = 0; o <= 3; o++) expect(cardWindow(rows, o, 4).reduce((n, c) => n + c.shown, 0)).toBe(4)
})

test('a wheel tick moves one row, a page key a window less a row, Home and End the whole way', () => {
  expect(scrollStep(1, 30, 30, 12, 50)).toBe(1)
  expect(scrollStep(-3, 30, 30, 12, 50)).toBe(-3) // ticks summed in flight
  expect(scrollStep(30, 30, 30, 12, 50)).toBe(11)
  expect(scrollStep(-30, 30, 30, 12, 50)).toBe(-11)
  expect(scrollStep(40, 30, 40, 12, 50)).toBe(51)
  expect(scrollStep(-40, 30, 40, 12, 50)).toBe(-51)
})
