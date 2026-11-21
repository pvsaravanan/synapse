# CLI reference

```
synapse <command> [options]
```

Commands that work on memory use the project of the **current directory** (see [Projects](concepts.md#projects)).

## Server and integration

| Command | Description |
|---|---|
| `synapse serve [--mode lite\|full]` | Start the stdio MCP server |
| `synapse hook [--agent claude\|cursor\|codex\|devin\|copilot\|gemini\|antigravity] [--event E]` | Handle one agent hook event read as JSON from stdin, and reply in that agent's format. `--event` supplies the event name for payloads that lack it (Copilot CLI, Antigravity). Always exits 0 |
| `synapse setup <claude\|cursor\|codex\|devin> [--global] [--dry-run] [--allow-tools] [--no-instructions]` | Install hooks, register the MCP server, add memory instructions to the project's `CLAUDE.md` / `AGENTS.md` ([details](agent-integration.md)), and load the repo's [team memory](concepts.md#team-memory) if it has one. `--no-instructions` skips the instructions. `--allow-tools` (Devin only) pre-approves Synapse's own tools, except `synapse_lt_approve`, in your user-level Devin permissions |
| `synapse setup git [--dry-run]` | Install a git `post-commit` hook that records each commit as a memory, from any agent or person ([details](agent-integration.md#git-hook-commits-from-any-agent)) |
| `synapse instructions` | Print the memory-instructions block setup adds to `CLAUDE.md` / `AGENTS.md`, to paste into a global file or another agent's rules |
| `synapse doctor` | Check Node, SQLite/FTS5, database path, project detection and git |
| `synapse doctor agents [--agent A] [--global] [--fix]` | Check what setup installed for each agent: hooks (all events present, paths valid), MCP entry (paths, `SYNAPSE_HOOKS` matching whether hooks exist), instructions block, git hook. Exits 1 on problems; `--fix` re-runs setup for the agents with problems ([details](agent-integration.md#checking-and-repairing-setup)) |
| `synapse uninstall [--agent A] [--global] [--dry-run]` | Remove what setup installed, keeping your own config and all memories ([details](agent-integration.md#uninstalling)) |
| `synapse version` | Print the version |

## Reading

| Command | Description |
|---|---|
| `synapse context [--task "…"]` | Print the project brief. The task can also be given as positional words |
| `synapse search <query…> [--global] [--limit N] [--type a,b] [--status S]` | Ranked index; `--status` is `active` (default), `resolved`, `archived` or `all` |
| `synapse detail <id…>` | Full records |
| `synapse timeline <id>` | Neighbours of one memory |
| `synapse stats` | Counts by status and type for this project |
| `synapse bench [--file F] [--auto] [--k N] [--keyword] [--json]` | Measure search quality on this project's memories: hit@1/3/k, recall and MRR for keyword search and for keyword plus meaning, from `.synapse/bench.jsonl` or generated cases; see [measuring retrieval](concepts.md#measuring-retrieval) |
| `synapse usage [--days N] [--limit N]` | Which curated memories get read and rated helpful (with a `synapse lt promote` suggestion for the most-read), and which weren't read in the last N days (default 30); see [usage](concepts.md#usage) |
| `synapse projects` | Every project with a memory count and last activity |

## Writing

| Command | Description |
|---|---|
| `synapse store --type T --title "…" [--entity E] [--narrative "…"] [--topic K] [--facts a,b] [--files a,b]` | Store a memory with `source: manual`. `--entity` defaults to `project` and `--type` to `discovery` |
| `synapse resolve <id…> [--status resolved\|archived\|active]` | Change status |
| `synapse stale [--limit N]` | List active memories whose files changed since they were stored ([file freshness](concepts.md#file-freshness)) |
| `synapse verify <id…>` | Mark memories as checked against current code; re-records their file hashes and clears the flag |
| `synapse ingest-git [--count N] [--since DATE]` | Import commits (default 20) |

## Sessions

| Command | Description |
|---|---|
| `synapse session` | List recent sessions |
| `synapse session start` | Start a session and print its id |
| `synapse audit [session-id] [--memory ID]` | What a session was shown (brief, searches, details, file notes, with ranks and what changed since; default: the latest session), or which sessions a memory reached; see [what each session was shown](concepts.md#what-each-session-was-shown) |
| `synapse session end [--summary "…"]` | Close the active session |
| `synapse checkpoint [--session ID] [--limit N]` | List compaction checkpoints, newest first |
| `synapse checkpoint show <id>` | Show one checkpoint in full (Synapse's and the agent's summaries) |

## Long-term memory

| Command | Description |
|---|---|
| `synapse lt list [--state S] [--query Q]` | List long-term items visible here (all states by default) |
| `synapse lt show <id>` | Show one item with its state, review reason and evidence |
| `synapse lt add --kind K --title "…" --text "…" [--scope user] [--applies "…"] [--evidence a,b]` | Propose an item |
| `synapse lt promote <memory-id> --kind K [--scope user]` | Propose an existing memory; it becomes the evidence |
| `synapse lt approve <id> --reason "…"` | Approve; only approved items reach the brief |
| `synapse lt archive <id> --reason "…"` | Archive (reject a proposal, or retire an approved item) |
| `synapse lt supersede <old> <new> --reason "…"` | Replace an approved item with a newer one |

`add` and `promote` take `--approve --reason "…"` to propose and approve in one step. Kinds: `semantic`, `procedural`, `episodic`.

## Maintenance and portability

| Command | Description |
|---|---|
| `synapse retention [--archive]` | Show retention zones; archive expired memories |
| `synapse ui [--port N] [--open]` | Browse and curate memory in a local web page ([details](#synapse-ui)) |
| `synapse consolidate [--dry-run]` | Merge ended sessions' auto-captured edit records per area and command runs per session, archive older duplicate command records and stale candidates, and re-apply the current capture rules to older command records ([consolidation](concepts.md#consolidation)). Runs automatically when a session ends (except the re-filter) |
| `synapse embed [--status \| --off]` | Turn on [meaning-based search](concepts.md#meaning-based-search-optional): downloads a ~23 MB model once and embeds this project's memories. `--status` shows the state and coverage; `--off` turns it off |
| `synapse team status` | Whether `.synapse/memory.jsonl` holds every shared memory; changes nothing ([team memory](concepts.md#team-memory)) |
| `synapse team export [--dry-run]` | Merge the file with this project's curated memories and write it: new memories get a stable id, removed ones become tombstones. Review and commit it |
| `synapse team import [--dry-run]` | Load the file into the local database now (setup, session start and the MCP server also do it whenever it changed) |
| `synapse export [--out FILE]` | Write this project's observations, sessions, checkpoints and long-term items as JSON (stdout by default) |
| `synapse import <file> [--project ID]` | Import a bundle into this project or another. Topic and duplicate rules apply, so re-importing is safe |

## Examples

```bash
# Brief for a task
synapse context --task "add rate limiting to the public API"

# Only fixes and gotchas about auth, across all projects
synapse search auth --type problem-solution,gotcha --global

# A decision that will evolve over time
synapse store --type decision --entity storage --topic decisions/storage/engine \
  --title "SQLite for local storage" --narrative "Zero-ops, single file, FTS5 built in."

# Move memory to a renamed repo
cd old-repo && synapse export --out /tmp/mem.json
cd ../new-repo && synapse import /tmp/mem.json
```

## synapse ui

```bash
synapse ui [--port N] [--open]
```

Starts a local web page for the project in the current directory (any project can be picked from the header):

- **Memories:** curated memories, grouped by day; tick **Include candidates** to mix in auto-captured ones. Search (matches are highlighted), filter by status and source, and narrow to one type with the chips, which show a count per type. Open a memory to see its narrative, facts, files, history (what it replaced or was replaced by) and feedback. The narrative is laid out for reading: Markdown is rendered, the first sentence becomes a summary line, "Label: ..." sentences become small headings, "(1) ... (2) ..." becomes a numbered list, three or more "; "-separated items become bullets, and file paths, `fn()` calls, `ENV_VARS`, `--flags` and camelCase or snake_case names show as code. Hook-captured commands show as a Command block and its Output. The action buttons stay pinned at the bottom of the panel.
- **Graph:** a node map of memories and the components (`entityName` and related entities) and files they name, so memories that share a file or component sit together. Memories are coloured by type (hollow for candidates, with a small orange dot when their files changed since); components are the large green nodes and files the small squares. Hover a node for a summary card; click a memory to open it, or a component, file or concept to list its memories (hovering one of those rows lights up its node). Double-click a node, or press `l` with it open, for its **local graph**: only the nodes 1, 2 or 3 steps away, with **Show all** (or `Esc`) to go back. Click the legend chips to hide or show a type, components or files. Toggle **Files**, **Concepts** (off by default) and **Candidates**, and filter by status. **Find a node** highlights matches, and `Enter` (`Shift+Enter` backwards) jumps to each in turn and opens it. Drag nodes or the background, scroll or pinch to zoom, double-click the background to zoom in, and use `+`/`−`, **Fit** (`f`) and **Forces** (sliders for repulsion, link length and gravity). The map shows up to the 400 most recent memories.
- **Changed since:** memories whose files changed after they were stored, with **Still true** (verified) and **Outdated** buttons. A flagged memory shows **what changed since it was stored**: the git diff of each changed file (up to 5, 400 lines each, secrets redacted) from the version the memory was stored or last verified against to the working tree, including uncommitted edits. The baseline is the committed version whose content matches the hash the memory recorded; when the memory was stored while the file had uncommitted edits, the last commit before then stands in, marked approximate. Created files show as all new and deleted ones as all removed. Only the project `synapse ui` was started in can be checked, since only its folder is known, and diffs need git.
- **Candidates:** auto-captured records, with **Keep** to qualify the useful ones. Tick several (or the box in the bar above the list, for all shown) to keep or archive them at once. Command records show as **Ran** or **Failed** plus the command, without the leading `cd` into the project.
- **Usage:** which memories actually help. **Read often** ranks curated memories by reads and helpful ratings, with a bar per memory and **Propose for long-term** (highlighted for the most-read and the helpful; the proposal waits in Long-term for your approval). **Not read in N days** lists memories stored before the window that no agent read in it, with **Resolve** and **Archive**. **Rated wrong** lists active memories rated conflicted, corrected or outdated. Memories stored inside the window and never read are listed separately as too new to judge. Pick a 7, 30 or 90-day window.
- **Sessions:** each session's agent, summary, checkpoints and records, and **What it saw**: every memory that reached the agent, in order (brief, searches, details, file notes), flagged with what changed since ([details](concepts.md#what-each-session-was-shown)). A memory's detail panel lists the sessions it was **Shown to**.
- **Long-term:** proposals to approve or reject, and approved items to retire, each with a required reason (recorded as "via synapse ui").

The top of the page shows curated, candidate, changed-since and session counts; click one to open that view. Every memory can be resolved, archived or reopened.

**Editing:** **Edit** (or `e`) opens the memory as a form: title, type, area, narrative, facts, files and concepts. On a candidate, **Save and keep** saves it and qualifies it in one step, so an auto-captured record can become a curated memory with a better title. Everything saved passes through secret redaction, and newly named files are hashed so they aren't flagged as changed straight away. `Cmd/Ctrl+Enter` saves; `Esc` cancels. **Merge…** folds duplicates into the open memory: it suggests similar memories (or search for one), and merging adds their facts, files, concepts and text (under a "Merged from #id" heading) to it, carries over their read counts, and archives them pointing at it. The editor opens afterwards to tidy the merged text. Keyboard: `/` focuses search, `j`/`k` (or the arrow keys) move through the list, `x` picks the open candidate, `e` edits the open memory, `Esc` closes the memory, cancels an edit, leaves the search box or (in the graph) the local graph, and `?` (or the round button at the bottom left) lists these keys.

The server listens on `127.0.0.1` only, answers only requests addressed to a local host name, and needs the access token in the printed URL for every API call, so other websites can't read or change your memory. The token changes each run. Stop it with Ctrl+C.

