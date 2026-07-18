---
name: arc-import
description: "Merge exported sessions in, newer-wins; optional re-root under dest"
argument-hint: "<archive> [dest]"
disable-model-invocation: true
---

The arc UserPromptSubmit hook normally intercepts /arc-import BEFORE the model runs (zero tokens). You are reading this because ONE of: (1) the command carried extra prose it does not take — in that case the prose IS the user's real message: answer IT, do not execute anything; (2) the command spanned multiple lines (the hook matches single-line commands only); (3) the hook is not wired in this session. Do NOT improvise this operation, whichever cause applies. For (2) and (3), tell the user the sentinel spelling `arc:import` (typed as ONE clean line) does the same thing — with `arc doctor` as the fix if the hook is genuinely unwired.
