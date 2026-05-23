# Claude Code hooks setup

The map widget already reflects what every Claude session is doing by tailing
`~/.claude/projects/**/*.jsonl`. JSONL gives us most of what we need, but two
signals are missed (or arrive late):

| Hook event   | What it tells us                                                  |
| ------------ | ----------------------------------------------------------------- |
| `Notification` | Claude is **waiting for the human** (idle prompt or a permission). The JSONL doesn't surface this explicitly. With the hook, the agent flips to `awaiting_approval` (yellow `?`) instantly. |
| `SessionEnd` | The session ended cleanly. Without the hook we only know once the 30-min activity window expires. With it, the house frees up right away. |

Setting up the hooks is a one-time edit in your Claude settings — Claude
itself runs the commands, so the widget gets a `curl` POST whenever the event
fires.

## Install

1. Make sure the map server is running (`npm run dev` in this repo). It must
   be listening on `http://localhost:4000`.

2. Open `~/.claude/settings.json`. If it doesn't exist, create it with `{}`.

3. Merge the snippet below into the file. If you already have a `hooks` block,
   add the `Notification` and `SessionEnd` arrays to it.

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -sf -X POST -H 'Content-Type: application/json' -d @- http://localhost:4000/api/hook >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -sf -X POST -H 'Content-Type: application/json' -d @- http://localhost:4000/api/hook >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

4. Restart any open Claude Code sessions so they pick up the new settings.

The `|| true` keeps the hook from failing the Claude turn when the map server
is offline — Claude continues normally, you just don't get the live update
until you reopen the widget.

## What you should see

- The next time Claude prompts you for confirmation or permission, the agent
  pops the yellow `?` glyph instantly instead of waiting for the JSONL to be
  flushed.
- When a session ends (you close the CLI or run `/exit`), the corresponding
  house frees up immediately, ready to be reassigned to another project.

## Removing the hooks

Delete the two array entries from `~/.claude/settings.json`. The widget keeps
working via JSONL watching alone, just with the two caveats above.
