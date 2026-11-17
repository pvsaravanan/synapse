# Concepts

## Observations

The unit of memory is an **observation**: one thing a future session should not have to rediscover. Each observation has:

| Field | Purpose |
|---|---|
| `type` | What kind of knowledge it is (see below) |
| `entityName` | The component or area it belongs to, e.g. `auth`, `billing`, `build` |
| `title` | Short summary, ~5–10 words |
| `narrative` | The full explanation |
| `facts` | Discrete, checkable statements, e.g. "Default timeout: 60s" |
| `filesModified` | Files involved; these feed the brief's "Start here" list |
| `concepts` | Keywords; some also control retention (see below) |
| `topicKey` | Optional stable key that turns a store into an update |
| `progress` | Optional `{ feature, status, completion }` for tracking work |
| `relatedCommits`, `relatedEntities` | Cross-references |
| `status` | `active`, `resolved` or `archived` |
| `source` | `agent`, `manual`, `git` or `hook` |
| `admissionState` | `qualified`, or `candidate` for unreviewed auto-captures |

### Types

| Type | Label | Use for |
|---|---|---|
| `gotcha` | GOTCHA | A non-obvious pitfall or trap |
| `decision` | DECISION | An architecture or design choice |
| `problem-solution` | FIX | A bug and how it was fixed |
| `trade-off` | TRADEOFF | A deliberate compromise |
| `reasoning` | REASONING | Why an approach was chosen (see `synapse_store_reasoning`) |
| `how-it-works` | INFO | An explanation of a mechanism |
| `why-it-exists` | WHY | The rationale behind existing code |
| `what-changed` | CHANGE | A notable change to code, config or dependencies |
| `discovery` | DISCOVERY | A new insight or learning |
| `session-request` | SESSION | A session's original goal |

### What not to store

Greetings, file reads, trivial commands, and anything that is obvious from the code itself.

## Projects

Every observation belongs to a project. Synapse works out the project from the working directory:

| Situation | Project id |
|---|---|
| Git repo with a remote | The normalized remote, e.g. `acme/app` |
| Git repo without a remote | `local/<repo-folder>` |
| Not a git repo | `dir/<folder>-<8-char path hash>` |

Remotes are normalized: `git@github.com:Acme/App.git`, `https://github.com/acme/app` and `ssh://git@github.com/acme/app` all become `acme/app`. Two clones of the same repo therefore share memory, even at different paths or over different protocols.

Search is project-scoped by default. Pass `scope: "global"` (MCP) or `--global` (CLI) to search across all projects.

## Writing memory: upserts and duplicates

When an observation is stored, Synapse goes through three checks in order:

1. **Topic upsert.** If `topicKey` is set and an active observation in the same project already has that key, it is **revised in place**. The content is replaced, files, concepts and cross-references are merged, and `revisionCount` goes up. Use this for evolving topics such as "the current auth session model". `synapse_suggest_topic_key` produces keys like `decisions/auth/session-model`.
2. **Duplicate merge.** Without a topic key, Synapse looks at recent active observations with the same entity and type. If one's title and narrative are at least **82% similar** (token-set Jaccard), the two are merged: the longer narrative wins and facts, files and concepts are combined.
3. **Insert.** Otherwise a new observation is created.

The result tells you which happened: `Stored`, `Updated topic` or `Merged into existing`.

Before any write, **credentials are redacted**:

- `name = value` assignments for passwords, secrets, tokens and API, auth, access and private keys
- Bearer tokens
- GitHub, OpenAI/Anthropic-style, AWS, Slack and JWT tokens
- PEM private keys

Prose such as "password must be 8 chars" is left alone.

## Reading memory: progressive disclosure

Retrieval is layered so agents spend tokens only on what matters:

| Layer | Tool | Cost | Shows |
|---|---|---|---|
| L1 index | `synapse_search` | ~20–40 tokens per hit | `#id date [TYPE] entity: title (flags) ~tokens` |
| L2 timeline | `synapse_timeline` | a few lines | What was recorded just before and after one memory |
| L3 detail | `synapse_detail` | the full record | Narrative, facts, files, provenance |

A typical flow: search → pick two or three ids → detail. An index line looks like this:

```
#14 2026-11-16 [GOTCHA] billing: Stripe webhooks need raw body (rev2) ~41t
```

Flags show `resolved`/`archived` status, `candidate` (auto-captured), and `revN` when the memory has been revised.

## Search ranking

Search uses SQLite FTS5 with BM25.

**Query handling.** Every query token is quoted, so user text can never inject FTS syntax. Tokens of four or more characters also prefix-match (`migrat` finds "migrations"). A small synonym table widens common terms, for example `bug` → fix/error/issue, `auth` → authentication/login/oauth/token, and `db` → database/sql. Stopwords are dropped.

**Column weights:** title 5, concepts 3, entity 2, facts 2, files 1.5, narrative 1.

**Final score:**

```
score = 0.7 × normalizedBM25 + 0.3 × relevance
```

Auto-captured `candidate` memories are multiplied by 0.45, so curated knowledge outranks comparable matches from logs. An empty query skips text matching and lists memories by relevance alone, which is useful for "what do we know?".

## Retention and relevance

Every memory has a relevance score that decays over time:

```
relevance = baseImportance × e^(−ageDays / retentionDays) × accessBoost × feedbackMultiplier
```

| Importance | Types | Base | Retention |
|---|---|---|---|
| critical | anything with concept `pinned`, `important`, `keep` or `critical` | 1.0 | 365 days |
| high | gotcha, decision, trade-off, reasoning | 0.8 | 180 days |
| medium | problem-solution, how-it-works, why-it-exists | 0.5 | 90 days |
| low | what-changed, discovery, session-request | 0.3 | 30 days |

**Adjustments to the retention window:**

- `source: hook` gets ×0.5 and `source: git` gets ×1.5.
- `valueCategory: ephemeral` gets ×0.5 and `core` gets ×2.
- The window never drops below 7 days.

**Boosts:**

- **Access:** each `synapse_detail` read adds 10%, capped at ×2.
- **Feedback:** each `helpful` signal adds 0.15 and each `conflicted`, `outdated` or `corrected` signal subtracts 0.15, clamped to ×0.4–×1.6. An `outdated` signal also resolves the memory.

**Immunity.** Critical memories, `core` memories, and memories read three or more times never fall below 0.5 relevance and are never archived.

**Zones.** A memory is *active* during the first half of its retention window, *stale* in the second half, and an *archive candidate* once the window has passed. `synapse_retention { archive: true }` (or `synapse retention --archive`) archives the candidates.

## Lifecycle

```
active ──resolve──▶ resolved
   │                   │
   └──archive──▶ archived ◀── retention sweep
```

Search, briefs and browsing show only `active` memories unless you ask for another status. Resolve memories when a bug is fixed or a decision is superseded, so they stop competing with current knowledge.

**Candidates** come from hooks and are visible but down-ranked. They never appear as cautions in a brief. `synapse_qualify` promotes the ones worth keeping.

## Reviewed long-term memory

Observations are cheap and plentiful. **Long-term memory** is a small, curated layer on top: things worth knowing in many future sessions, each one explicitly approved with a recorded reason. Only approved items reach the brief.

| Kind | Holds | Example |
|---|---|---|
| `semantic` | a stable fact | "The API is stateless; auth is JWT" |
| `procedural` | how to do something | "Release: build, test, tag only after CI is green" |
| `episodic` | a notable event | "1.2.0 was tagged before CI finished" |

**Scope.** `project` items stay in the project they were proposed in. `user` items are portable: they appear in every project's brief. Use `user` only for personal preferences the user actually stated.

**Lifecycle.** An item starts `proposed`, from an agent (`synapse_lt_propose`), a person (`synapse lt add`), or by promoting an existing memory (`fromMemoryId` / `synapse lt promote`), in which case that memory becomes its evidence. Review moves it to `approved` or `archived`. Superseding replaces an approved item with a newer one, which keeps the history and points the old item at its replacement. Every review action needs a reason.

**Who approves.** You do. Agents can propose and archive freely, but `synapse_lt_approve` is marked as requiring user interaction, so Claude Code asks you on every call in every permission mode, including accept-edits, auto and bypass. Allow rules don't skip it, and where no prompt is possible (`claude -p`) the call is denied. Other agents ask through their normal MCP permission prompt; a broad allow rule there would skip it, so Devin's `--allow-tools` leaves `synapse_lt_approve` out. From the terminal, `synapse lt approve` is the human path. The brief notes how many proposals are waiting, and `synapse lt list --state proposed` shows them.

Proposals whose title matches a live item in the same scope return the existing item instead of creating a duplicate. Text and evidence go through secret redaction.

## Sessions

A session groups the work of one agent run:

- `synapse_session_start` opens a session and returns the latest handoff summaries.
- `synapse_session_end { summary }` closes it with a handoff: what was done, what's left, where to resume.

With an agent's hooks installed, sessions follow that agent's own session or conversation ids. They close automatically with a generated summary (goal, files touched, memories stored).

### Compaction checkpoints

When an agent compacts its context, its hook records a **checkpoint**: Synapse's generated summary at that moment, plus the agent's own compaction summary when it provides one (Devin). Each compaction adds a new checkpoint; earlier ones are kept, so a long session leaves a trail of how the work progressed. A compaction with nothing new since the last checkpoint adds no row. Checkpoints go through secret redaction like everything else.

When the same session starts again after compaction or on resume (`SessionStart` with `source` `compact` or `resume`), its latest checkpoint leads the injected brief. With `SYNAPSE_HOOK_INJECT=minimal`, a single "Last checkpoint" line is still added. A new session never sees another session's checkpoint.

List them with `synapse checkpoint`, or read one in full with `synapse checkpoint show <id>`. They are included in `synapse export`.

## The project context brief

`synapse_project_context { task }` is the recommended first call for non-trivial work. It returns a small, bounded brief (1,200 tokens by default) shaped by a **task lens** detected from the task text:

| Lens | Triggered by words like | Emphasizes |
|---|---|---|
| bugfix | bug, fix, error, crash, failing, regression | gotchas, past fixes |
| release | release, publish, version, changelog, deploy | gotchas, decisions |
| refactor | refactor, rename, extract, simplify | decisions, trade-offs, gotchas |
| test | test, spec, coverage, flaky | gotchas |
| docs | docs, readme, documentation | decisions |
| onboarding | overview, architecture, understand, explore | decisions, rationale |
| feature | add, implement, build, support | decisions, gotchas, trade-offs |
| general | anything else | gotchas, decisions |

Sections, all trimmed to fit the budget:

- **Checkpoint:** only when resuming a session after compaction; its latest checkpoint.
- **Long-term:** approved long-term items (this project's and user-scope), task matches first.
- **Start here:** files from the most relevant memories, ranked. Each memory's weight is split across its files, so one wide change can't flood the list, and only files that still exist are shown.
- **Relevant memories:** search hits for the task. Hook-captured candidates are left out (they still count toward Start here), as are memories already shown through an approved long-term item.
- **Cautions:** the most relevant qualified memories of the lens's caution types.
- **In progress:** memories with an unfinished `progress`.
- **Last session:** the latest handoff summary (from an earlier session, when resuming).
- **Verify:** lens-specific checks, such as "Add/extend a regression test".

When long-term proposals are waiting, a line at the end says how many.

On a project with no memories yet, the brief says so plainly, so the agent doesn't keep searching. User-scope long-term items still appear.

## Git memory

`synapse_ingest_git` (or `synapse ingest-git`) turns recent commits into memories.

**Type inference.** Conventional-commit prefixes map directly: `fix:` → problem-solution, `feat:`/`refactor:`/`chore:` → what-changed, `docs:` → how-it-works, `test:` → discovery, `perf:` → trade-off, `security:` → gotcha. Without a prefix, keywords in the message decide.

**Entity.** The conventional-commit scope (`fix(auth): …` → `auth`), or else the directory most of the changed files live in.

**Noise filter.** These are skipped:

- merge commits
- bare version bumps
- `wip`/`fixup!`/`squash!` commits
- commits that only touch lockfiles, minified files, `dist/` or source maps

**Bulk commits** (more than 40 files, e.g. an initial import) are stored without a file list.

**Idempotent.** Each commit is stored once, keyed by its hash.

## Knowledge graph (full mode)

In full mode, Synapse also exposes a per-project entity/relation graph. It is compatible with the tools of the standard MCP memory server: `create_entities`, `create_relations`, `add_observations`, `read_graph`, `search_nodes`, `open_nodes` and the delete tools. The graph is stored separately from observations.
