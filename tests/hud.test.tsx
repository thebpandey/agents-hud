import { expect, mock, test } from 'claude-code/testing'

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

const REPO = '/home/me/dev/proj'
const WT = `${REPO}/.claude/worktrees/lane-a1-auth`

// Each hook here stands for the engine.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], crowd = 0) {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'agents-hud' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: REPO }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 50_000, window: 200_000, percent: 25 },
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
      { id: 'a1', description: 'auth refactor', type: 'sonnet-lane', status: 'running', name: 'auth-coder' },
      { id: 'a2', description: 'look for usages', type: 'Explore', status: 'completed' },
      { id: 'a3', description: 'docs pass', type: 'glm', status: 'running' },
    ],
  }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', (_, e) => {
    const isScan = (e as unknown as { argv: string[] }).argv[0] === 'bash'
    const t = Math.floor(Date.now() / 1000)
    const job = ['model-relay.abc123', 'deepseek', '', '', WT, '', '', String(t - 60), '', '1'].join('\t')
    return { value: { exitCode: 0, stdout: isScan ? `${job}\n` : `${REPO}/.git\n`, stderr: '' } }
  })
  on('fs.read', () => ({ value: `lane\tagent\ttask\tworktree\trelay\na1-auth\tSonnet 5.5 (T2)\tAuth refactor\t.claude/worktrees/lane-a1-auth\tagent\n` }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('tool.call', () => ({ result: {} }))
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`agents view and usage footer (${surface})`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: REPO, surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /auth-coder/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /This session/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /5-hour.*14%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Weekly.*22%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Context.*25%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /GLM 5\.3 Flash/ })).toBeTruthy()
    // An agent with no name of its own gets a robot name before its description.
    expect(await ui.find({ type: 'Text', text: /^[A-Z][a-z]+$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /look for/ })).toBeTruthy()
    await ui.unmount()
  })

  test(`a crowded panel shrinks the cards, then pages them (${surface})`, async ($, on) => {
    engine(on, 30)
    await $.session.start({ cwd: REPO, surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 30 } } })

    expect(await ui.find({ type: 'Text', text: /task 0/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /task 29/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /▼ \d+ more below/ })).toBeTruthy()
    // The usage footer stays in view while the cards page.
    expect(await ui.find({ type: 'Text', text: /5-hour.*14%/ })).toBeTruthy()
    for (let i = 0; i < 5; i++) if (await ui.find({ key: 'more-down' })) await ui.press({ key: 'more-down' })
    expect(await ui.find({ type: 'Text', text: /task 29/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /▲ \d+ more above/ })).toBeTruthy()
    await ui.unmount()
  })

  test(`lanes view groups an agent under its lane (${surface})`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: REPO, surface, isInteractive: true })
    await $.agent.spawn({ prompt: `Work in ${WT}. Follow the brief.`, description: 'auth refactor', subagentType: 'sonnet-lane' })
    await $.tool.call({ tool: 'Skill', skill: 'lanes' })
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /Lanes · proj/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /a1-auth/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /⎇ lane-a1/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /DeepSeek V4\.1 Flash/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /relay/ })).toBeTruthy()
    await ui.unmount()
  })
}
