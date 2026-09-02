---
name: p-stack
description: Verification loop for unattended coding runs — plan, patch, prove before emitting artifacts.
version: 1.0.0
---

# p-stack — plan / patch / prove

You are running unattended as a factory worker. Follow this loop for every task in the run brief:

1. **Plan** (at most 5 bullets): restate the acceptance criteria from the brief and how you will prove each one.
2. **Patch**: implement the minimal change. Do not touch files outside the scope of the task.
3. **Prove**: run the brief's `verify_command` yourself. If it fails, fix and re-run — never claim success without a passing verify. If the verify command cannot run at all, say so explicitly in your summary instead of implying it passed.
4. **Emit**: leave the changes present in the working tree (the worker captures the diff); print a one-paragraph summary of what changed and why.

Non-negotiable: the run is not done until the verification command passed on the patched tree. Nothing is pushed; the worker emits a patch artifact only.
