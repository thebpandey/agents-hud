# agents-hud

A Claude Code side panel that lists the agents in your session, each on a card with a pixel-robot avatar, a name and branch, a live status (Thinking, Generating, the tool it's running, Idle, Done) with tool count and run time, a context bar and the model.

- **Agents view:** the default. It shows this session's card first, then every subagent and teammate. Press an agent's name to open its transcript.
- **Lanes view:** switches on once you run `/lanes` in the session. It groups agents under the lanes in the lanes skill's `lanes.tsv` registry, matching each agent to a lane by the worktree path in its brief. Lanes with something running come first, then lanes whose agents have finished (latest first). Lanes with nothing in this session fold into one "▸ N more lanes" row that opens on a click. Agents that match no lane go under "Other agents". In every list, running agents come before finished ones.
- **External agents:** background relay jobs started by the lanes skill (`model-relay`, `codex-lane`, `codex-review`) appear as cards under their lane, or under "External jobs" when they match no lane. Each card shows its real engine, such as DeepSeek or GPT-6.1-sol, and whether it's running, done, failed or stopped. Relay subagents (`deepseek`, `glm`, and the rest) show the external model instead of their Haiku relay. External cards have no context bar.
- **Names:** every subagent and external job gets a robot name (Nova, Bolt, Pixel…) the moment its card appears, shown before its description. A name stays with its agent for the session, and no two cards share one. Teammates keep the name they were given.
- **Crowding:** cards shrink to fit the panel, from full cards with a 3-row robot, to 2-row compact cards, to one line each. Past that the header and this session's card stay put, and the cards between them scroll with the mouse wheel, the arrow keys while the panel has focus, or the ▲/▼ "more" rows.
- **Usage:** at the foot of the side panel by default, or in a band above the prompt (`⇠ to chat` / `⇢ to panel`, or `/agents-hud chat` / `/agents-hud panel`). It shows the context, 5-hour and weekly bars with reset countdowns and local reset times. `▾ more` opens upward with:
  - the context window, with tokens used, the window size and where autocompact starts;
  - what fills the window (messages, system tools, skills, memory files…);
  - a pace line under each limit: when you'd run out at your current rate, or "Resets before you'd run out". A time on any day but today also shows its date.

  The settings row under it holds more, theme, avatar style and placement.
- **Motion:** an avatar moves only while its agent works. It bobs and blinks while thinking, bounces while generating, and flashes its accent while running a tool. Idle, done and stopped agents stand still. `/agents-hud motion off` keeps them all still.
- **Avatar styles:** robots, cats, slimes, aliens and owls. `☺` in the band, or `/agents-hud avatars [style]`, switches style, and new sessions keep it.
- **Themes:** Claude, Ember, Amber, Harbor, Forest, Bone, Wine and Terminal (your terminal's own colours, for light backgrounds). `🎨` in the band, or `/agents-hud theme [name]`, switches theme, and new sessions keep your pick.

`/agents-hud`, or `◫ panel` in the band, opens the panel again after you close it. `/agents-hud lanes`, `/agents-hud agents` or `/agents-hud auto` sets the grouping. `/agents-hud more` opens or closes the breakdown, and `/agents-hud theme` switches theme.

On the desktop app the avatars are drawn as SVG pixel art. The terminal draws them with half-block characters.

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
