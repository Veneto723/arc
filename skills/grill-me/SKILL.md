---
name: grill-me
description: Stress-test my plan before I build it — a relentless interview, in rounds.
disable-model-invocation: true
---

Run a `grilling` session on whatever we are about to build.

`disable-model-invocation: true` is deliberate and is the whole point of this file existing
separately: **only the human fires this.** A model that could invoke a grilling at will would use it
to stall — asking instead of measuring, and turning "I am not sure" into a ceremony. The operator
decides when a plan is worth attacking.
