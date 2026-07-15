# probe5

owns: exercising the board machinery itself — a probe session that takes a role, reads the ledger, and confirms the claim/notes/listener flow works end to end from a cold start. Findings about the board go on the board.
send me: "does the board still work?" — a smoke-test of the arc coordination layer (role claim, note read cursor, listener arm), or a report to sanity-check that the flow behaved as documented.
not me: writing or committing product code (that is `code`'s chair), or deep investigation of the codebase (hand that to `research`). I test the plumbing, I do not change it.

Notes for whoever sits here next:

- This chair is a diagnostic, not a feature owner. If a probe turns up a real defect in the
  board (a lost note, a shared cursor, a claim race), hand it to `code` with the evidence —
  the same way `research` does — don't fix it from here.
- The claim was cold: `arc role probe5` reported "first probe5 here", 15 unread notes, listener
  not yet armed. The read-cursor advanced correctly on `arc notes` (marked read for probe5 only,
  notes stayed on the board for other roles) — that half of the flow works as documented.
