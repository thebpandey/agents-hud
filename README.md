# agents-hud

A side panel for Claude Code that shows every agent in your session at a glance. Each agent has a card with a pixel-art avatar, a name, what it's working on, a live status (Thinking, Generating, the tool it's running, Idle, Done), its context use and its model. At the bottom of the panel you see your session's context and your plan's 5-hour and weekly limits, with reset times and a pace forecast.

While the `/lanes` skill runs, the panel groups agents under their lanes. It also shows the external relay and Codex jobs that the lanes skill starts.

It works in the Claude Code CLI (terminal) and in the Claude Code desktop app, on Linux and macOS. It makes no model calls and adds nothing to your prompts, so it uses no tokens.

## Install

Requires Claude Code 2.1.275 or later.

### Claude Code CLI (terminal)

At the prompt of any Claude Code session, run:

```
/plugin install agents-hud --marketplace thebpandey/agents-hud
```

1. Answer `y` to add the marketplace.
2. Press Enter to pick the **user** scope, so the mod loads in every session.

You can also install it from a shell instead of a session:

```
claude plugin install agents-hud --marketplace thebpandey/agents-hud
```

The mod starts working in the current session right away, and in every session after it.

### Claude Code desktop app

`/plugin` doesn't run in the desktop app. Use the app's plugin menu instead:

1. In a Code session, click **+** next to the prompt box.
2. Choose **Plugins**, then **Add marketplace**, and enter `thebpandey/agents-hud`.
3. Click **Add plugin** next to agents-hud.

If you already installed the mod from a terminal at the user scope on the same computer, you're done: the desktop app's local sessions load it too. Cloud sessions run on a remote machine, so they don't load it.

## Use

### Opening the panel

- **CLI:** the panel opens by itself beside the chat in fullscreen mode, or when your terminal is at least 144 columns wide. In a narrower terminal, run `/agents-hud` to open it.
- **Desktop app:** the panel opens on your first prompt of each session. To open it sooner, or after you close it, run `/agents-hud`.

If you close the panel, it stays closed until you run `/agents-hud` again.

### What you see

- **Header:** the panel's top line shows the mod's name and installed version (for example `Agents HUD v0.2.15`), so you can tell whether an update has loaded. While `/lanes` runs, the right side shows the repo and lane count.
- **This session** is the top card. Below it are your subagents and teammates, running ones first, then the most recently active. A finished agent stays as long as Claude Code still lists it, and leaves the panel 10 minutes after Claude Code stops listing it. A finished relay or Codex job leaves 10 minutes after it ends.
- **Names:** each subagent and job gets a name of its own (Nova, Bolt, Pixel…), which it keeps for the session.
- **Click an agent's name** to open its transcript.
- **Avatars move while their agent works** and stand still once it's idle or done.
- **Lanes:** after you run `/lanes`, agents the session starts directly (outside any lane) are listed first, under **Direct agents**. Below them, agents are grouped under their lane, with a rail down the left of each lane's cards. Lanes with something running come first. Lanes with nothing in this session fold into one "▸ N more lanes" row that you can click to expand.
- **Narrow panel:** what each agent is doing keeps the room. The context bars shrink first (all together, so they stay lined up), then the branch, and only then the description. Widen the panel to read more of it.
- **Many agents:** cards shrink to fit the panel, down to two lines each (never one). If they still don't fit, the list scrolls a row at a time with the mouse wheel or trackpad. The header, this session's card and the usage footer stay in place.

### Usage stats and settings

The bottom of the panel shows three bars, each in its own colour:

| Bar | Shows |
|---|---|
| **Context** | Tokens used of the context window |
| **5-hour** | Your 5-hour plan limit, with a reset countdown and the local reset time |
| **Weekly** | Your weekly plan limit, with a reset countdown and the reset day and time |

Any bar turns amber at 60% and red at 85%.

The row under the bars holds the settings:

| Button | What it does |
|---|---|
| `▴ more` / `▾ less` | Opens a detailed view above the bars: what fills the context window (messages, system tools, skills, memory files), where autocompact starts, and a pace line under each limit, such as "⚠ At this pace you'll run out by 4:12 PM" or "✓ Resets before you'd run out". Every usage bar is drawn at one length so they compare at a glance: in this view each bar's figures (tokens, reset time) sit on the line under it; with it shut they sit beside the bars under the short labels the bar above the prompt uses (CTX, 5H, 7D), and the bars get shorter so the reset time still fits ("↻ 6d 23h · Thu 1 PM"), down to the countdown alone in a very narrow panel. Above the prompt it fits on screen without scrolling: a wide terminal sets the context and the limits side by side, and a short one folds the smallest context categories into one "N smaller" row |
| `🎨 Claude` | Switches to the next colour theme |
| `☺ robots` | Switches to the next avatar style |
| `⇠ to chat` | Moves the usage stats to a band above the prompt, under the chat. There, `⇢ to panel` moves them back, and `◫ panel` opens or closes the side panel |

Themes: Claude, Ember, Amber, Harbor, Forest, Bone, Wine, and Terminal, which uses your terminal's own colours and suits light backgrounds.

Avatar styles: robots, cats, slimes, aliens, animals (12 animal faces) and owls.

Your theme, avatar style, motion and usage placement are kept for new sessions.

### Commands

| Command | What it does |
|---|---|
| `/agents-hud` | Opens the panel |
| `/agents-hud lanes`, `agents` or `auto` | Groups by lane, lists all agents, or switches to lanes automatically once `/lanes` runs (the default) |
| `/agents-hud more` | Opens or closes the detailed usage view |
| `/agents-hud theme [name]` | Switches theme, to the next one or the one you name |
| `/agents-hud avatars [style]` | Switches avatar style, to the next one or the one you name |
| `/agents-hud panel` / `chat` | Puts the usage stats in the side panel or in the band above the prompt |
| `/agents-hud motion on` / `off` | Turns avatar animation on or off |

## Update

From a terminal on each computer:

```
claude plugin update agents-hud
```

Then run `/reload-plugins` in any open CLI session, or start a new session. In the desktop app, start a new session.

## Uninstall

```
claude plugin uninstall agents-hud
```

## Troubleshooting

- **No panel in the CLI:** your terminal is under 144 columns and not in fullscreen. Run `/agents-hud`, widen the terminal, or use fullscreen mode.
- **No panel in the desktop app:** send a prompt, or run `/agents-hud`. If you closed the panel earlier in the session, only `/agents-hud` reopens it.
- **A second list of agents under the prompt:** that's Claude Code's own background-task list, not this mod. Press `ctrl+t` to hide or show it.
- **An agent is under "Direct agents" instead of its lane:** the panel matches an agent to a lane when its brief names the lane's worktree path, its lane folder, or the lane by name. Mention one of those in the agent's brief.
- **No 5-hour or weekly bars:** plan limits arrive with Claude's next response. Until then the panel shows "Plan limits arrive with the next response."

## How it works

The mod is one TypeScript hooks module that runs inside Claude Code's plugin sandbox. It has no network access and no background process of its own.

| What | Where it comes from |
|---|---|
| Agents and their activity | Claude Code's agent list and each agent's tool calls and turns |
| Context and plan limits | The same figures as Claude Code's status line |
| Context breakdown | A local estimate that makes no API calls |
| Lanes | The lanes skill's registry at `~/.local/state/lanes/<repo>-<hash>/lanes.tsv` |
| External jobs | The lanes skill's job folders in `~/.local/state` (`model-relay.*`, `codex-lane.*`, `codex-review.*`) |

In the terminal the avatars are drawn with half-block characters. In the desktop app they're drawn as SVG pixel art.
