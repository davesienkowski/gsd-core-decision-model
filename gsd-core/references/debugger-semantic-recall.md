# Semantic Knowledge-Base Recall via MemPalace

Loaded by `gsd-debugger` via `@-include` from the `knowledge_base_protocol`
Matching Logic. Replaces keyword-overlap matching with **semantic recall** so a
prior session that resolved "requests hang under load" surfaces for a new "API
times out when many users connect" — same root cause, no shared keywords.

## Why this exists

The knowledge base's self-noted limitation was explicit: *"Matching is keyword
overlap, not semantic similarity."* Keyword overlap only fires on lexical
coincidence — the highest-value recalls (same root cause, different wording)
are exactly the ones it misses, and its value decays as the corpus grows.

## The approach — reuse MemPalace, add no new infrastructure

Layer semantic recall on top of the existing knowledge base by **reusing
MemPalace** (the semantic-memory capability already in this environment) —
**without adding new embedding or vector infrastructure** (Choose Boring /
Zawinski: spend no new "innovation token" on a bespoke vector store the
debugger would own).

`.planning/debug/knowledge-base.md` remains the **durable plain-text source of
truth**; semantic recall is an additive layer over it, not a replacement.

## Write — index resolved sessions at archive

At `archive_session`, after appending the entry to `knowledge-base.md` (the KB
append + commit MUST succeed first — `knowledge-base.md` is the durable source
of truth; skip indexing on KB-write failure), **index the resolved session into
MemPalace**.

**Index the agent-authored `Resolution` summary — `root_cause(s)` + `fix` + the
Prevention `recurrence_guard` — NOT the raw user-supplied `Symptoms`.** The
Resolution is the post-investigation, agent-synthesized signal; indexing it
(rather than raw symptoms) excludes attacker-controlled prose from the
cross-session index and reduces secret/PII leakage. Even so, **redact
secret-shaped values** (API keys, bearer tokens, JWTs, passwords, credentials)
from the summary before indexing — a bug report's error string can echo a
secret, and MemPalace is a cross-session, cross-project store.

## Invocation (the agent has no MCP tools — use the CLI)

The `gsd-debugger` `tools:` frontmatter grants no MCP tools, so query and index
via the **Bash CLI** (the headless/autonomous path): `mempalace search
"<symptoms>" --wing <wing>` to recall, and the matching index command on
archive. If an `mempalace_search(query, wing)` MCP tool is registered in the
runtime, prefer it. **Resolve the wing** from `config.mempalace.wing` → else the
project's `project_code` → else the project directory name (the same precedence
every other MemPalace integration uses).

## Read — query MemPalace at Phase 0

At Phase 0, **query MemPalace semantically with the current symptoms** and
surface the **top-k meaning-similar prior resolutions** as candidate
hypotheses. Each surfaced candidate flows into Evidence exactly as a
keyword-match candidate would — a hypothesis to test first, not a confirmed
diagnosis.

This catches the **same-root-cause / different-wording** case: a prior
"requests hang under load" resolution surfaces for "API times out when many
users connect" even though no keywords overlap.

## Graceful degradation — MemPalace absent

When MemPalace is unavailable (not installed, not configured, or the query
errors), **fall back to keyword-overlap matching** against
`knowledge-base.md`: extract nouns, error substrings, and **identifiers**
(function/variable names — often the highest-signal token) from
`Symptoms.errors` and `Symptoms.actual`, and scan each entry's `Error patterns`
field for **2+ token overlap (case-insensitive)**. The fallback is logged
(Kernighan — never a silent skip), and `knowledge-base.md` continues to be
written regardless, so no session is lost to a missing palace.

## Decision-model candidates (optional, keyword-fallback path)

Runs only on the keyword-fallback path (MemPalace absent or failing), and only when `gsd_run decide --status` prints `"active": true`. Define `gsd_run` with your launcher preamble at the start of the same Bash call, then make one call per `~/.claude/gsd-core/references/decision-model-calls.md` (### KB recall). Every `ok` `same_cause` answer is a candidate.

Keyword matches are never removed and are tested first. Model-only candidates follow, by confidence descending, ties in file order. An entry found both ways is listed once, naming both sources. Each candidate carries its `decided-by:` line. A candidate is a hypothesis to test, never a diagnosis. Abstain, error or no `ok` answer: log one line and change nothing.

## Scope boundary (Zawinski's Law)

An additive recall layer over the existing knowledge base, reusing an existing
semantic-memory capability. Not a new command, not a vector database, not an
embedding pipeline the debugger owns. Where MemPalace is absent the debugger
behaves exactly as it did before this layer — keyword matching against the
plain-text knowledge base. Optional decision-model candidates never replace keyword matches.
