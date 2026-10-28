# agents-hud

A Claude Code side panel that lists the agents in your session, each on a card with a pixel-robot avatar, a name and branch, a live status (Thinking, Generating, the tool it's running, Idle, Done) with tool count and run time, a context bar and the model.

- **Agents view:** the default. It shows this session's card first, then every subagent and teammate. Press an agent's name to open its transcript.
- **Lanes view:** switches on once you run `/lanes` in the session. It groups agents under the lanes in the lanes skill's `lanes.tsv` registry, matching each agent to a lane by the worktree path in its brief. Agents that match no lane go under "Other agents".
- **External agents:** background relay jobs started by the lanes skill (`model-relay`, `codex-lane`, `codex-review`) appear as cards under their lane, or under "External jobs" when they match no lane. Each card shows its real engine, such as DeepSeek or GPT-6.1-sol, and whether it's running, done, failed or stopped. Relay subagents (`deepseek`, `glm`, and the rest) show the external model instead of their Haiku relay. External cards have no context bar.
- **Names:** every subagent and external job gets a robot name (Nova, Bolt, Pixel…) the moment its card appears, shown before its description. A name stays with its agent for the session, and no two cards share one. Teammates keep the name they were given.
- **Crowding:** cards shrink to fit the panel, from full cards with a 3-row robot, to 2-row compact cards, to one line each. Past that the header, this session's card and the usage footer stay put, and the cards between them scroll with the mouse wheel, the arrow keys while the panel has focus, or the ▲/▼ "more" rows.
- **Footer:** session context, 5-hour usage and weekly usage, each with a bar and its reset countdown and local reset time.

`/agents-hud` opens the panel. `/agents-hud lanes`, `/agents-hud agents` or `/agents-hud auto` sets the grouping.

The panel docks beside the chat in fullscreen mode, or when the terminal is at least 144 columns wide.

Runs on Linux and macOS.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agents-hud --marketplace thebpandey/agents-hud
```

Answer `y` to add the marketplace, then press Enter for the user scope. From a shell:

```
claude plugin install agents-hud --marketplace thebpandey/agents-hud
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `thebpandey/agents-hud`, then Add plugin.

To update: `claude plugin update agents-hud`, then `/reload-plugins`.
