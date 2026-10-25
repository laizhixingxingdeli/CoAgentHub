---
name: coagent-l2
description: Operate a CoAgentHub v5 direct-controller mission (coordinationMode "direct") from a Codex session - this session acts as the L2 controller: plan, contract check, frozen work orders, dispatch, per-item review and the submit closing step. Use together with the coagent-l3 skill.
---

# CoAgentHub v5 L2 主控 in Codex

Use this skill when a Mission was created with `coordinationMode: "direct"` and
this session is the controller. **Direct mode = two skills together**: this one
for the controller work (L2 duty), `coagent-l3` for the final review, boundaries
and red lines. `docs/direct-controller.md` is the rulebook — read it in full
before your first direct mission; its rules are not restated here.

You plan, run the contract check, freeze work orders, dispatch, review each item
against its current ValidationReport, and close. The platform runs only
executors; there is no coordinator model, and controller actions are recorded
as `direct.controller_action`.

Closing has **two steps, and the platform performs neither automatically**:

1. After all items are accepted: `coagenthub_direct_control` action `submit` —
   hand in the Mission result. Submitting is not merging.
2. The Mission then enters `awaiting_review`: switch to `coagent-l3`, run its
   final-review checklist, and sign `coagenthub_finalize_mission`. The checklist
   is the precondition for signing, not a reason to defer it.
