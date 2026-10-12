---
name: ss
description: Load the user's latest Scry Snip capture into the conversation and act on it. Use when the user types /ss (optionally followed by an instruction, a capture id, or "shared"), or says they just snipped, grabbed or screenshotted something with Scry Snip ("look at my snip", "fix what I just snipped", "the screenshot I just took"). Not for Storybook component screenshots (use search_components / get_component_screenshot) or for setting Scry up (use scry-setup).
---

# Scry Snip: use the latest snip

The user just took a snip with Scry Snip (in Scry Sync) and wants you to look at
it. Fetch it with the Scry MCP server, confirm which snip you got, then do what
they asked. Anything typed after `/ss` is the instruction (for example
`/ss fix the spacing in this card`).

## 1. Pick the capture

Read the text after `/ss`:

- **Empty, or a plain instruction:** call `latest_capture` once, with no
  arguments. This is the default.
- **A capture id** (`cap_…` or a UUID): call `get_capture` with that id.
- **"shared"** or "the one X sent me": call `list_captures` with
  `scope: "shared"`, then `get_capture` on the newest match.
- **"previous", "the one before", a count like "last 3":** call
  `list_captures` (scope `mine`) and `get_capture` each id you need.

Call each tool once per request. Never poll or loop waiting for a new snip.

## 2. Handle errors

| Error | Do |
| --- | --- |
| `CAPTURE_STALE` | Tell the user the newest snip's id and age and ask whether to use it. On yes, call again with `maxAgeMinutes` just above that age (max 1440). |
| `AMBIGUOUS_PROJECT` | If the repo names a Scry project (`.storybook-deployer.json` `project`, `.scry/config.json`, `SCRY_PROJECT_ID`) and it is in the list, retry with that `project_id`. Otherwise show the listed projects and ask. |
| `CAPTURE_NOT_READY` | Wait a few seconds and retry once. |
| `CAPTURE_NOT_FOUND` | Say no snip was found and ask the user to take one (Scry Sync: Control+Option+4 on Mac, Ctrl+Shift+4 on Windows, or the tray menu's Snip item). Do not retry or guess ids. |
| `RATE_LIMITED` | Say so and stop. |

If no Scry MCP tools (`latest_capture`) are available, the Scry MCP server is
not connected: tell the user, and offer the `scry-setup` skill to connect it.

## 3. Confirm, then act

Start your reply with one line naming the snip, so the user can catch a wrong
one: `Using snip cap_7k3f (2 min old).` Include the note if the snip has one.

Then:

- **With an instruction:** do it, using the picture as the spec. For code
  changes, find the matching component or screen in the repo before editing,
  and compare against the picture again after.
- **Without an instruction:** describe what the snip shows in two or three
  sentences (screen, the region that looks like the point of the snip, any
  visible problem) and ask what to do with it.

The inline picture is at most 1280 px on its long edge. When fine detail matters
(small text, 1 px borders, exact colors), download the full-resolution link from
the tool result; it expires in one hour.
