---
name: show-image
description: Show an image file to the USER. Reading an image shows it to YOU (the model) ONLY — the human never sees it, and Claude Code cannot render images inline in the terminal (it rejects sixel/kitty/iTerm2 graphics sequences). So if you have an image the human must actually look at — a QR code to scan, a chart, a screenshot, a diagram, a generated preview — you MUST use this skill or they will never see it. Opens the image in their default viewer. Cross-platform (Windows/macOS/Linux).
---

# show-image — put an image in front of the human

## The fact this exists for
When you `Read` an image, **it is rendered to you, not to the user.** Their terminal shows only "Read <file>". Claude Code also cannot draw images inline (graphics escape sequences are explicitly rejected). So an image you can "see" is invisible to them until you open it.

**Never tell the user to look at an image you have only `Read`.** That's the bug this skill prevents.

## When to use
- You generated something they must eyeball or act on: a **QR code to scan**, chart, diagram, rendered page, screenshot, before/after preview.
- They asked "show me" / "what does it look like".
- You are about to write "as you can see in the image above" — stop; they can't.

## When NOT to use
- You read an image purely to analyze it yourself (debugging a screenshot). Don't pop a window they didn't ask for.
- The user pasted the image (they've already seen it).

## Be polite — this opens a real window on their screen
A window appearing unannounced is intrusive and **steals keyboard focus**, possibly mid-sentence.

1. **Did they ask for it?**
   - **They asked** ("show me the chart", "let me scan the QR") → say *"opening it now"*, then open. Expected, not intrusive.
   - **You're volunteering it** (they didn't ask) → **ASK FIRST**: *"I have a QR you'll need to scan — want me to open it in a window?"* Open only on yes. An unrequested window is an ambush.
2. **Never let the window be the first they hear of it.** Announce, then open — in that order, always.
3. **Only when they need to look.** One image, when there's a reason. Don't pop windows during your own analysis.
4. **Respect the user's mode** (`CL_SHOW_IMAGE`). If they chose `notify` or `off`, no window opens — relay the path the script prints rather than insisting.
5. **Don't re-open the same image.** If you already showed it, point at the window that's open.

## How
```bash
node ~/.claude/skills/show-image/show.js "<absolute/path/to/image.png>"
```
It opens the image in the OS default viewer and prints a one-line confirmation. Then **tell the user what to do with it** (e.g. "the window that just opened has the QR — scan it with the app").

Flags: `--dry` prints the command without opening (for testing).

**The human controls how intrusive this may be.** The mode comes from `CL_SHOW_IMAGE`, else from `features.showImage` in `~/.claude/cl-config.json` (a standing preference), else `open`:

| mode | behaviour |
|---|---|
| `open` *(default)* | opens the image in the OS viewer — **steals keyboard focus** |
| `notify` | desktop toast, **no window, no focus steal**. On Windows the toast is **clickable — it opens the image**. On macOS/Linux the toast can't launch, so relay the path. |
| `off` | prints the path only — never opens anything |

In `notify`/`off` the script prints the path and exits 0. **Do not fall back to opening it another way** — the user chose this on purpose. Tell them the image is ready: on Windows, *"click the notification to view it"*; elsewhere, give them the path.

## Notes
- Works on Windows (`start`), macOS (`open`), Linux (`xdg-open`). No dependencies.
- Headless/SSH sessions have no viewer — the script says so and prints the path instead of failing silently.
- In `notify` mode the toast previews the image itself: a **wide** image (screenshot) uses the 2:1 banner, a **square-ish** one (QR, diagram) uses an uncropped square thumbnail.
