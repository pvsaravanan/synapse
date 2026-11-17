---
name: synapse-memory
description: Use Synapse project memory - get a task brief before non-trivial work, search past decisions/gotchas/fixes, and store durable learnings, reasoning and session handoffs.
---

# Synapse memory

**Start of non-trivial work:** call `synapse_project_context` with the user's actual task. Read its "Start here" files first. Current code and the user's request always beat memory.

**Search** (`synapse_search`) when a past decision, bug or design rationale would help. It returns a compact index; expand only the ids you need with `synapse_detail`, or `synapse_timeline` for what happened around one. If it reports a fresh project, do not repeat the search this turn.

**Store** (`synapse_store`) only what a future session should not have to rediscover:

| Situation | type |
|---|---|
| Architecture/design choice | `decision` |
| Bug found and fixed | `problem-solution` |
| Non-obvious pitfall | `gotcha` |
| Config/dependency change | `what-changed` |
| Deliberate compromise | `trade-off` |

Titles ~5-10 words; include `filesModified`. For evolving topics pass a `topicKey` (see `synapse_suggest_topic_key`) so the record is revised, not duplicated. For "why" decisions use `synapse_store_reasoning`.

**Lifecycle:** `synapse_resolve` finished/obsolete memories; `synapse_feedback` when a memory helped or was outdated (a memory flagged `changed since: …` names files edited after it was stored: check current code, then send `verified` or `outdated`); `synapse_qualify` hook-captured candidates worth keeping; `synapse_session_end` with a handoff summary (done / left / where to resume).

Do not store greetings, trivial reads, command noise or secrets (credentials are redacted anyway).
