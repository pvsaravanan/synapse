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

1. **Topic upsert.** If `topicKey` is set and an active observation in the same project already has that key, it is **revised in place**. The content is replaced, files, concepts and cross-references are merged, and `revisionCount` goes up; the replaced version is kept in the memory's [history](#memory-history). Use this for evolving topics such as "the current auth session model". `synapse_suggest_topic_key` produces keys like `decisions/auth/session-model`.
2. **Duplicate merge.** Without a topic key, Synapse looks at recent active observations with the same entity and type. If one's title and narrative are at least **82% similar** (token-set Jaccard), the two are merged: the longer narrative wins and facts, files and concepts are combined.
3. **Insert.** Otherwise a new observation is created.

The result tells you which happened: `Stored`, `Updated topic` or `Merged into existing`.

Before any write, **credentials are redacted**:

- `name = value` assignments for passwords, secrets, tokens and API, auth, access and private keys
- Bearer tokens
- GitHub, OpenAI/Anthropic-style, AWS, Slack and JWT tokens
- PEM private keys

Redaction covers every stored text field: title, narrative, facts, concepts, related areas and the `topicKey` (hooks derive topic keys and concepts from commands, which can carry a token). Prose such as "password must be 8 chars" is left alone.

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

Flags show `resolved`/`archived` status, `candidate` (auto-captured), `revN` when the memory has been revised, and `changed since: <files>` when files it names have changed since it was stored (see below).

## File freshness

A memory about code can go out of date when the code changes. When a memory names files (`filesModified`), Synapse records a short content hash of each one at store time. Later, if a file's content differs, the memory is **flagged, not hidden**:

```
#14 2026-11-16 [GOTCHA] billing: Stripe webhooks need raw body (changed since: src/webhooks.ts) ~41t
```

- **Where it shows:** search results, `synapse_detail` (with each file marked `modified`, `deleted` or `created`), the brief's relevant memories and cautions, and `synapse stale`. A flagged reply carries a one-line hint to check current code before relying on it.
- **Seeing what changed:** [`synapse ui`](cli.md#synapse-ui) shows the git diff of each changed file since the memory was stored: Synapse finds the committed version whose content matches the recorded hash and diffs it against the working tree.
- **Clearing the flag:** after checking, send `synapse_feedback` with `verified` (still true: the hashes are re-recorded) or `outdated` (resolves it). From the terminal: `synapse verify <id>` or `synapse resolve <id>`. Re-storing under the same `topicKey` also refreshes the hashes of the files it names.
- **A session's own edits don't count.** Agents often store a decision and then implement it. When a hook captures an edit, memories from the same session that name that file are re-hashed. When the session ends (`SessionEnd` or `synapse_session_end`), files the session edited are re-hashed once more, which also covers a later shell edit (`sed`, a script) to those files. Changes to any other file still flag, whether you made them in your editor or another agent did, and so do edits in a later session.
- **Limits of that rule.** Hooks only see edit and write tools, so a file the session changed *only* through shell commands flags its own memories (one check to clear). Agents without hooks get edit records from the git working tree instead (see [agents without hooks](agent-integration.md#agents-without-hooks)); outside git they have none, so their own edits flag too. A memory the session made wrong later in the same session isn't flagged. With two agents on one project, a memory stored over MCP is tagged with the project's most recent active session, which may be the other agent's.
- **What's tracked:** only files inside the project, up to 25 per memory. Files over 2 MB are compared by size. A file that didn't exist when the memory was stored is flagged as `created` once it appears.
- **Not tracked:** git-ingested and imported memories, and memories stored before this feature. `verified` starts tracking an untracked memory from that moment.

## Search ranking

Search uses SQLite FTS5 with BM25.

**Query handling.** Every query token is quoted, so user text can never inject FTS syntax. Tokens of four or more characters also prefix-match (`migrat` finds "migrations"). A small synonym table widens common terms, for example `bug` → fix/error/issue, `auth` → authentication/login/oauth/token, and `db` → database/sql. Stopwords are dropped.

**Column weights:** title 5, concepts 3, entity 2, facts 2, files 1.5, narrative 1.

**Final score:**

```
score = 0.7 × normalizedBM25 + 0.3 × (1 − e^−relevance)
```

Relevance (below) can exceed 1 for a much-read, well-rated memory, so it is bounded to 0..1 before it is weighed: it orders memories but cannot outweigh a much better text match.

Auto-captured `candidate` memories are multiplied by 0.45, so curated knowledge outranks comparable matches from logs. An empty query skips text matching and lists memories by relevance alone, which is useful for "what do we know?".

### Meaning-based search (optional)

Keywords miss memories worded differently: "crash" doesn't find "panics", "signed out" doesn't find "session cookie". **`synapse embed`** turns on meaning-based search with a small sentence-embedding model (`Xenova/all-MiniLM-L6-v2`, about 23 MB) that runs inside Synapse, on your machine, through [transformers.js](https://huggingface.co/docs/transformers.js).

- **One download, then offline.** `synapse embed` downloads the model once into `~/.synapse/models` (from Hugging Face) and embeds the project's memories. After that, nothing goes over the network: a search never downloads, and with the model missing it simply stays keyword-only. On networks that inspect TLS with their own root certificate (curl works, Node reports `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`), it retries the download trusting the system certificate store.
- **Blended, not replaced.** Each memory's cosine similarity to the query counts as *related* when it is at least 0.15 and at least 60% of the best match for that query (measured with this model, related pairs scored 0.19–0.48 and unrelated ones up to 0.17). Related memories gain score and join the results even without a shared word; a keyword match the model calls unrelated ("out" in "index out of range" for "signed out") keeps three quarters of its score. Meaning is *added* to the keyword score (at most half a full match, then rescaled), so a closer meaning breaks ties and finds reworded memories without lifting a weak keyword match level with an exact one. `synapse bench` (below) is how these weights were chosen.
- **Kept current lazily.** Vectors are stored per memory with a hash of the embedded text, and new or edited memories are embedded before the next search (up to 500 at a time).
- **Where it applies:** `synapse_search`, `synapse search` and the search box in `synapse ui`. The session-start brief stays keyword-only, so hooks never load the model and starting a session stays fast.
- **Optional dependency.** The runtime (`@huggingface/transformers` with ONNX Runtime, about 300 MB in `node_modules`) is an optional dependency: if it fails to install, Synapse works as before, keyword-only.
- `synapse embed --status` shows whether it's on and how many memories have vectors; `synapse embed --off` turns it off (vectors are kept). `SYNAPSE_EMBED=1`/`0` overrides either way.

### Measuring retrieval

**`synapse bench`** measures how often search puts the right memory near the top, on the project's own memories. Each case is a query plus the memories that answer it; every case runs through the same search agents use (the project's active memories, auto-captured candidates included), keyword-only and, when the model is downloaded, keyword plus meaning. Nothing is recorded as a read.

```
                    hit@1  hit@3 hit@10  recall   MRR
keyword               82%    92%   100%   100%   0.88
keyword + meaning     89%   100%   100%   100%   0.93
```

- **hit@k:** share of cases with an expected memory in the top k. **recall:** share of all expected memories found in the top k. **MRR:** mean of 1/rank of the first expected memory (0 when it is missing).
- **Cases** come from **`.synapse/bench.jsonl`** (or `--file`): one `{"query": "...", "expect": ["<title>"], "kind": "symptom"}` per line. A memory is named by its title (exact, or a prefix only it has), `#id` or team uid; `kind` is a free label results are grouped by. Lines starting with `//` are comments. Add a case whenever search misses something, so the benchmark grows with the real questions. Commit the file to share it with the team, or add it to `.gitignore` to keep it local.
- **`--auto`** (and the default when there is no file) generates cases from the curated memories: each title, and a sentence from each text. These share words with their memory, so they flatter keyword search; written paraphrases and symptoms ("sessions stay open after the agent quits") are what separate keyword from meaning-based search.
- The report lists cases whose memory was not in the top 3, with what ranked first instead, and cases naming memories that no longer exist. `--keyword` skips meaning-based search, `--k N` changes the cutoff (default 10), and `--json` prints every case.

## Team memory

Curated memories can be shared through the repository, so teammates and CI agents get the same gotchas and decisions through git while each machine keeps its own local database. `synapse team export` writes them to **`.synapse/memory.jsonl`**; commit it like any other file, and review it in pull requests.

```
{"uid":"m-3f9c2a7b1e04","type":"gotcha","entity":"ui","title":"UI page is a String.raw template: no backticks or ${ in page JS","narrative":"…","files":["src/ui-page.ts"],"fileHashes":{"src/ui-page.ts":"9a1c…"},"createdAt":"…","updatedAt":"…"}
{"uid":"m-0b7d51c9a2e6","status":"resolved","title":"Old caching decision","updatedAt":"…"}
```

- **What's shared:** active, curated memories (stored by an agent or person, or candidates someone kept). Not git-ingested memories (each clone can ingest its own history), not auto-captured candidates, and not memories with the concept **`private`**. Text passes through secret redaction again, and absolute paths into the project or your home directory are rewritten (`src/…`, `~/…`), so no machine-specific paths reach the repo.
- **One line per memory, oldest first**, so a new memory is an appended line and an edit is a one-line diff. Each line has a stable `uid` (local ids differ per machine) and the content hashes of its files, so [changed since](#file-freshness) flags work on every machine.
- **Removals are tombstones.** A shared memory that is resolved, archived or made private becomes a short line with its `status` and title, so the removal reaches teammates explicitly. (A missing line could just mean an older branch.) Tombstones are dropped after 180 days.
- **Merging is last-writer-wins per memory**, on `updatedAt`: importing an older file (another branch, an old commit) never undoes newer edits, and a tombstone only removes a memory that wasn't edited after it. `synapse team export` imports the file first, so a teammate's lines are never dropped, and rewrites the file only when its content changes.
- **Loading is automatic.** Setup, every session start (before the brief) and the MCP server import the file whenever its content changed since the last load, so after a `git pull` the next session knows what the team knows. Imported memories are tagged `team`. `SYNAPSE_TEAM=0` turns automatic loading off; `synapse team import` loads on demand.
- **A memory both of you stored** before sharing (same area, type and near-identical text) adopts the shared `uid` instead of becoming a duplicate.
- **`synapse team status`** says whether the file is current, without changing anything: handy as a CI check before merging.

- **The file is untrusted input.** A clone can contain anything, so imports are checked: file names must stay inside the project (no `..`, no absolute paths, nothing in `.synapseignore` or the secret-file defaults), file hashes must look like Synapse's own, and timestamps more than a day in the future are rejected (a far-future `updatedAt` would otherwise win every merge, and a tombstone could never remove it). Synapse refuses to read or write `.synapse/` or `memory.jsonl` when either is a symbolic link, and export replaces the file atomically instead of writing through it.

The file is project knowledge, read by agents like `CLAUDE.md` is, so review changes to it the same way.

## Usage

A **read** is a memory reaching an agent: included in a brief (relevant memories that fit its token budget), opened with `synapse_detail`, or shown as a [file note](agent-integration.md#file-notes). Browsing in `synapse ui` doesn't count. Synapse keeps each memory's total reads and the time of its last read, plus its feedback, and `synapse usage` (or the **Usage** view in `synapse ui`) turns that into what to keep:

- **Read often:** curated memories by reads plus two per helpful rating. The ones with at least 3 reads and at least half the top memory's count, or a helpful rating, and no negative one, are suggested for [long-term memory](#reviewed-long-term-memory). Memories in the brief are read every session, so a fixed bar would mark nearly all of them.
- **Not read in N days:** stored before the window (default 30 days) and not read in it, never-read first. Archive what no longer earns its place, or resolve what stopped being true.
- **Too new to judge:** stored inside the window and never read yet.
- **Rated wrong:** still active, but rated conflicted, corrected or outdated.

Only the last read's time is kept, so "read often" counts all reads ever, shown with when the last one was. Auto-captured candidates are left out; they have their own lifecycle ([consolidation](#consolidation)).

## Memory history

Revising a memory doesn't lose what it said before. Whenever a curated memory's content changes (a topic update, a near-duplicate merged into it, an edit, a merge, an update from the [team file](#team-memory), or a restore), the version it replaced is kept with when it was written, when it was replaced, what replaced it and, for agent stores, the session.

- **`synapse history <id>`** lists the versions, newest first, each with what the next change did (title, type or area changes, narrative lines added and removed, facts and files). `--diff` prints the narrative lines; `--rev N` shows one version in full.
- **`synapse history <id> --at 2026-03-01`** shows what the memory said on that date: "what did we believe before the refactor?"
- **`synapse history <id> --restore N`** brings back version N. The version it replaces is kept too, so a restore can be undone the same way.
- Agents use **`synapse_history`** (`id`, optional `at` or `revision`) to see how a decision evolved.
- In **`synapse ui`**, a memory with earlier versions has a **History** section: each version with a diff against the next one and a **Restore this version** button.

Only content changes count: resolving, archiving or reopening a memory doesn't add a version, and neither does storing the same text again. Auto-captured candidates keep no history (they are logs), and each memory keeps its last 50 versions. History is local to your database; the team file carries only the current version.

## What each session was shown

Reads say how often a memory is used; Synapse also records **which session saw which memory, and why**, so "why did the agent do that?" has an answer when a stale or wrong memory misled it.

Every memory (and approved long-term item) that reaches an agent is logged per session:

- **Brief** at session start, or from `synapse_project_context`: the task, and the section each memory was in (relevant, caution, long-term). Only what fit the token budget counts, because the rest never reached the agent. The MCP server's own start brief is logged once the agent has seen it.
- **Search** (`synapse_search`): the query, and each hit's rank and score. Hits cut by `maxTokens` are not logged.
- **Detail** (`synapse_detail`): the ids opened.
- **File note**: the file read or edited.

Each row keeps the title as shown and whether the memory was flagged *changed since stored* at that moment. Viewed later, rows add what happened since: **edited since** (the text changed, not just the status), **rated wrong since** (outdated, conflicted or corrected feedback), **now resolved/archived**, or **deleted**.

- **`synapse audit [session-id]`** prints a session's timeline (default: the latest session); **`synapse audit --memory <id>`** lists the sessions a memory reached. Use it when marking a memory outdated, to see who it may have misled.
- In **`synapse ui`**, a session's **What it saw and stored** shows the timeline, and each memory's detail panel lists **Shown to**.
- Queries pass through secret redaction. Rows are kept 90 days and pruned when a session ends; `SYNAPSE_AUDIT_DAYS` changes that, and `0` turns recording off. The CLI and `synapse ui` are people, not agents, so they are not recorded.

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
- **Feedback:** each `helpful` or `verified` signal adds 0.15 and each `conflicted`, `outdated` or `corrected` signal subtracts 0.15, clamped to ×0.4–×1.6. An `outdated` signal also resolves the memory.

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

### Consolidation

Hooks keep one rolling record per edited file and per command, which piles up: a session touching ten files in one area leaves ten records, and every session's `npm test` leaves another "Ran: npm test". So when a session ends:

- **Edit records merge per area.** Two or more in one area (the entity from the path, such as `api` for `src/api/limit.ts`) become one record, `Changed api: src/api/limit.ts, src/api/routes.ts +1`, listing each file with an excerpt of its change and the session's goal. A session that closes again (Antigravity, after each turn) folds new edits into the same record.
- **Older duplicate command records are archived.** Only the newest "Ran: `<command>`" per command is kept, matched on what the command runs (`npm test | tail` counts as `npm test`).
- **A session's command runs merge into one record**, `Ran 3 commands: npm test, npm run build, npm run lint`, listing each command with how often it ran. A resumed session folds new runs into the same record.
- **Stale candidates are archived.** Auto-captured candidates that nobody kept, read or rated within 14 days are archived (`SYNAPSE_CANDIDATE_DAYS`; `0` turns it off).

Originals are archived, not deleted, with `supersededBy` pointing at the record that replaced them (stale candidates have none), and can be reopened. Records you qualified or that were retrieved (`synapse_detail`) are left alone, and so are a session's fixes, failures and goal. `synapse consolidate [--dry-run]` does the same for sessions that ended before consolidation existed, and also re-applies the current [capture rules](agent-integration.md#capture-rules) to older command records, archiving unreviewed searches and file prints that older versions kept.

### Ignored files

A `.synapseignore` file at the project root lists files Synapse never captures as edits (from hooks or the working-tree tracker) and never hashes for [file freshness](#file-freshness). It uses gitignore-style patterns, and the last match wins:

```gitignore
# generated code
dist/
/build
src/**/*.generated.ts
!.env.example        # re-include a file the defaults ignore
```

Secret-shaped files are ignored by default: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.pypirc` and `.netrc`. Memories can still name an ignored file in `filesModified`; it just isn't tracked. Commit `.synapseignore` so everyone's agents skip the same files.

## Reviewed long-term memory

Observations are cheap and plentiful. **Long-term memory** is a small, curated layer on top: things worth knowing in many future sessions, each one explicitly approved with a recorded reason. Only approved items reach the brief.

| Kind | Holds | Example |
|---|---|---|
| `semantic` | a stable fact | "The API is stateless; auth is JWT" |
| `procedural` | how to do something | "Release: build, test, tag only after CI is green" |
| `episodic` | a notable event | "1.2.0 was tagged before CI finished" |

**Scope.** `project` items stay in the project they were proposed in. `user` items are portable: they appear in every project's brief. Use `user` only for personal preferences the user actually stated.

**Lifecycle.** An item starts `proposed`, from an agent (`synapse_lt_propose`), a person (`synapse lt add`), or by promoting an existing memory (`fromMemoryId` / `synapse lt promote`), in which case that memory becomes its evidence. Review moves it to `approved` or `archived`. Superseding replaces an approved item with a newer one, which keeps the history and points the old item at its replacement. Every review action needs a reason.

**Who approves.** You do. Agents can propose and archive freely, but `synapse_lt_approve` is marked as requiring user interaction, so Claude Code asks you on every call in every permission mode, including accept-edits, auto and bypass. Allow rules don't skip it, and where no prompt is possible (`claude -p`) the call is denied. Other agents ignore that marker, so `synapse_lt_approve` refuses them and points to `synapse lt approve` or `synapse ui` instead; `SYNAPSE_AGENT_APPROVAL=1` lets them approve through their own permission prompt (Devin's `--allow-tools` still leaves the tool out). Every call must repeat the item's title, scope and body, and is refused when they don't match, so the prompt shows exactly what you approve. From the terminal, `synapse lt approve` is the human path. The brief notes how many proposals are waiting, and `synapse lt list --state proposed` shows them.

Proposals whose title matches a live item in the same scope return the existing item instead of creating a duplicate. Text and evidence go through secret redaction.

## Sessions

A session groups the work of one agent run:

- `synapse_session_start` opens a session and returns the latest handoff summaries.
- `synapse_session_end { summary }` closes it with a handoff: what was done, what's left, where to resume.

With an agent's hooks installed, sessions follow that agent's own session or conversation ids. They close automatically with a generated summary (goal, files touched, memories stored). Without hooks, the MCP server runs one session per server process, closed with the same kind of summary when the agent disconnects ([details](agent-integration.md#agents-without-hooks)).

### Compaction checkpoints

When an agent compacts its context, its hook records a **checkpoint**: Synapse's generated summary at that moment, plus the agent's own compaction summary when it provides one (Devin). Each compaction adds a new checkpoint; earlier ones are kept, so a long session leaves a trail of how the work progressed. A compaction with nothing new since the last checkpoint adds no row. Checkpoints go through secret redaction like everything else.

When the same session starts again after compaction or on resume (`SessionStart` with `source` `compact` or `resume`), its latest checkpoint leads the injected brief. With `SYNAPSE_HOOK_INJECT=minimal`, a single "Last checkpoint" line is still added. A new session never sees another session's checkpoint.

Without hooks, the MCP server writes rolling checkpoints itself, and a later `synapse_project_context` call in the same session leads with one ([details](agent-integration.md#agents-without-hooks)).

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
- **Relevant memories:** search hits for the task. Hook-captured candidates are left out (they still count toward Start here), as are memories already shown through an approved long-term item. Memories whose files changed since they were stored are marked `changed since: …`.
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
