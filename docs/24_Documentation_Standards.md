# SAMVARDIQ

## Documentation Standards

**Version:** 1.0

**Status:** Active

**Owner:** Founder Office

**Last Updated:** 03 September 2026

---

## Purpose

This document records working conventions for how Samvardiq's
engineering process operates day to day — conventions that are not
themselves architecture (see `docs/04_Architecture.md`, frozen) but
govern how implementation and approved decisions move through the
repository.

---

## Guiding Principle

> "A checkpoint that isn't in the canonical remote didn't happen."

---

## Standing Engineering Rule: Checkpoint Synchronization

After a Samvardiq implementation or approved architecture checkpoint
passes required validation, the checkpoint must be committed and
pushed to the canonical Git remote before dependent implementation
begins.

### Why

Work that exists only in a local working tree or an unpushed local
commit is not yet part of Samvardiq's institutional record — it is
invisible to anyone else, to CI, and to a future session that resumes
from `origin/main`. Starting the *next* piece of dependent work on top
of an unpushed checkpoint risks silently diverging from what the
canonical remote believes is true, and risks losing validated work if
it is never pushed.

### What counts as a checkpoint

- A session of implementation work that passes its required validation
  (typecheck, lint, tests, build, as applicable).
- An architecture/governance decision (an ADR, a `docs/11_Decisions.md`
  entry) that has been formally approved by the Founder.

### The rule

1. Validation must pass before a commit is made.
2. The commit must be pushed to `origin/main` (or the applicable
   canonical remote) before a *dependent* session begins new
   implementation work on top of it.
3. Unrelated, not-yet-approved, or pre-existing in-progress files must
   not be swept into a checkpoint commit merely because they happen to
   be present in the working tree.

This rule does not apply to exploratory or in-progress work within a
single session — only to completed, validated checkpoints that later
work will depend on.
