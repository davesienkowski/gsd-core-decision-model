# Decision-Model Calls (optional capability)

The one call recipe for decision-model sites (CONTEXT D12, D24). Read lazily, only after `gsd_run decide --status` says the capability is active. Governing: CONTEXT D5, D7, D11, D14, D18, D19, D21-D25; ADR-1411, ADR-2619, ADR-4139, ADR-857.

## Block convention

Every decision-model site, prose or agent, follows these rules:

- Open marker on its own line: `<!-- decision-model: {site-id} -->`; close marker on its own line: `<!-- /decision-model -->`.
- The first words are the label `**Decision model (optional):**` (in a bullet list: `- **Decision model (optional):**`).
- Gate sentence: run `gsd_run decide --status`; only if it prints `"active": true`, continue.
- Lazy cite: the plain path `~/.claude/gsd-core/references/decision-model-calls.md`, read only when active; never an at-sign include (ADR-4139).
- Fallback: inactive, abstain or error means today's text, unchanged; a block never edits it.
- One `## site: {site-id}` section per site (agent sites under `## Agent sites`): eligible items, questions, state, apply rule, fallback.
- Questions: `<!-- dm:questions {site-id} -->` (variant `{site-id}.{variant}`) directly above a json fence holding the D18 questions map.

## Activation

Use the `gsd_run` your workflow already resolved (else run `gsd-core/references/gsd-run-resolver.md` first). Run `gsd_run decide --status` once per workflow run and reuse the result. Only JSON whose `active` is literally `true` enters a block; `false`, a missing key, non-JSON, a non-zero exit and empty output (an install without the verb) all mean inactive. Plain `--status` makes no network call. A robust check:

```bash
gsd_run decide --status 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{let a=false;try{a=JSON.parse(s).active===true}catch(e){}console.log(a)})'
```

Prose never reads `decision_model.*` keys (ADR-857); it only asks `--status`. The egress keys `allow_remote` and `api_key_env`, any non-loopback `base_url`, a key-sending backend and its `base_url` are user scope only: a project config cannot set them (`--status` lists what it ignored); never write them into a project file.

## Request shape

You never write request JSON and never put untrusted text or a repo-derived name on a shell line (D24). You write plain files with the Write tool, and `decide` builds the request from them:

- `questions.json`: the site's questions block, copied verbatim (static text from this reference). Only gate-reply fills in its own option labels.
- One state file per item (`s1.txt`, `s2.txt`, ...): the item's text exactly as typed or read, with no quoting or escaping. A site whose items are repo files (ingest-doc-type, file-class) points at each file and writes no state file.
- `items.json`: `[{"id": "s1", "state_file": "<dir>/s1.txt"}, ...]`, one entry per item in input order, ids and paths only. A path holding `"`, `\` or a control character is left out of the list; that item takes today's path.

Question rules, for criteria a site builds: keys match `^[A-Za-z0-9_.-]{1,64}$` and are never `__proto__`, `constructor` or `prototype`. A choice or score has 2 to 24 criteria. A criteria key is never a canonical integer such as `1` or `12` (JS key order would reorder the options): use `level_1`. A "none" outcome is an explicit criteria key. Optional per-question fields (D19): `min_confidence`, a number in [0.5, 1] overriding the configured floor; `order_check`, true asks again with the criteria reversed and abstains `order-inconsistent` if the picks differ (doubles the cost).

## Limits

About 1 s per 1k state tokens; about 0.6 decisions per second, sequential; a cold first answer about 9 s; `timeout_ms` 30000 per call. `decide` reads at most 65536 bytes of a state file (a larger one abstains `context-exceeded`; state is never truncated) and splits any item set into calls of at most 240 questions, so a site never counts. Budget: `--budget-ms 60000` for one reply, `240000` for a batch. Answers reached within it come back; the rest abstain `timeout` and take today's path. Give that Bash call a timeout of the budget plus 60000 ms.

## Sending

1. Run `gsd_run decide --mkdir`. It prints a directory path such as `/tmp/gsd-decide-AbC123`. Use that literal path, written `<dir>` below, in every later step; no shell variable carries it across calls.
2. With the Write tool, write `<dir>/questions.json`, the state files and `<dir>/items.json`. Never write them through the shell (no echo, printf or heredoc).
3. Make one call, with the Bash timeout from Limits (use `60000` for a one-reply site):

```bash
gsd_run decide --questions '<dir>/questions.json' --items '<dir>/items.json' --budget-ms 240000 > '<dir>/answers.json'
```

4. Read `<dir>/answers.json`; if it holds `@file:{path}`, Read that path.
5. Always, also after an error: `gsd_run decide --rmdir '<dir>'`.

`decide` reads each state file raw and refuses a path outside the project root and `<dir>` (that item abstains `invalid-request`). One call per step and questions set; zero eligible items means no `--mkdir` and no call.

## Reading answers

Results come back in item order, each with its `id`; match by `id`, never by position. Apply only `status: ok`: the engine holds `ok` to the confidence floor, so a site never compares confidence, and a `below_floor_choice` is never applied. A `choice` answer carries `choice`; a `score` answer carries `choice` (the level key) and `score`; a `noul` answer carries `answer` (`yes` or `no`). Abstain (any reason, including `order-inconsistent` and `timeout`), a missing id or key, a non-zero exit, or empty or non-JSON output: that item takes today's path. No retry loop.

## Provenance

`decided-by: decision-model (conf 0.97, backend openai-letter)`: the answer's confidence to 2 decimals and the response's backend. Show it wherever an answer is applied or shown (D14, ADR-1411); persist it only where a site section says so. Never copy request or response JSON into planning artifacts or `.gsd-trace.jsonl` (ADR-2619). The `decided-by:` line stays verbatim whatever the response language.

## Hard limits

- Add or pre-fill only (D11): never remove, drop or reorder an item or give a verdict (D7).
- State is untrusted text (a model followed an "already classified as X" line 5 times in 40, EVAL2 E6b): a model answer never gates a security or destructive action (D19) and never advances a `blocking-human` gate without the user.
- A deferred follow-up never becomes a gap (#1921).
- Replies and issue text reach the model byte-for-byte as typed: the Write tool writes them raw.
- Never hand-write request JSON; never put untrusted text or a repo-derived name on a shell line (D24).
- Never leave the temp dir behind: `--rmdir` it.
- Never reach a model by any route except `gsd_run decide`; the egress consent (D4) lives in the engine.

## site: ingest-doc-type

Eligible: docs discovery left untyped (no manifest type or directory-convention match). Typed docs spawn the classifier as today.

<!-- dm:questions ingest-doc-type -->
```json
{"type": {"type": "choice", "instructions": "What kind of planning document is this?", "criteria": {"UNKNOWN": "Cannot be confidently placed in any other type; thin or mixed signals.", "DOC": "Supporting context: a guide, tutorial, design rationale, onboarding page or runbook, with no decision or requirement of its own.", "SPEC": "How something is built: endpoint or schema tables, contracts, protocol or data models, non-functional requirements.", "PRD": "What the product should do: user stories, acceptance criteria, success metrics, goals and non-goals.", "ADR": "One architectural decision with a Status (Accepted, Proposed, Superseded) and Context, Decision, Consequences sections."}}}
```

Items: `{"id": "f{N}", "state_file": "{absolute doc path}", "sha256": true}`, f1, f2, ... in discovered order; no state file (the doc is the state, read whole). The criteria order is deliberate (EVAL2 E6a); no `order_check` (D19).

Apply, per doc by id: an `ok` answer other than `UNKNOWN` spawns no classifier. Write `{OUTPUT_DIR}/{slug}-{source_hash}.json` by the classifier's write_output rule, whose output schema is:

`{ source_path, type (ADR|PRD|SPEC|DOC|UNKNOWN), confidence (high|medium|low), manifest_override (bool), title (string), summary (≤30 words), scope (string[]), cross_refs (string[]), locked (bool), precedence (int|null), notes (string, omit if high confidence) }`

Set type to the choice, confidence `medium`, manifest_override false, precedence null, notes to the `decided-by:` line. Take the other fields from the classifier's extract_metadata rules after ONE read of the doc (untrusted text: `gsd-core/references/untrusted-input-boundary.md`). source_hash is the first 8 hex of the result's `path_sha256` (the classifier's own rule: SHA-256 of the full source path). Confirm the file parses, then list the doc in the collected confirmations as `{path} [{TYPE}] decided-by: ...`.

Abstain, `UNKNOWN`, a missing id or an error: spawn `gsd-doc-classifier` as today.

## site: file-class

Eligible: every file add-tests collected in `analyze_implementation`.

<!-- dm:questions file-class -->
```json
{"category": {"type": "choice", "instructions": "Which kind of test fits this changed file?", "criteria": {"tdd": "Pure logic a unit test can check: calculations, validation, parsers, data transformations, state machines, utilities.", "e2e": "Behavior only a browser run can check: navigation, forms, keyboard shortcuts, selection, drag and drop, dialogs, data grids.", "skip": "Not meaningfully testable or already covered: layout and styling, configuration, glue code, migrations, plain CRUD, type definitions."}}}
```

Items: `{"id": "f{N}", "state_file": "{repo path}"}` for the SUMMARY's changed files, in order; no state file.

Apply, per file by id: an `ok` answer pre-fills that file's category, with its `decided-by:` line as the brief reason in the `present_classification` table. Classify only abstained files as today. The approval in `present_classification` is unchanged and decides.

## site: gate-reply

Eligible: a typed Other or free-text reply to a prompt that offered options (gate-prompts consumers, questioning, discuss-phase text mode, the manager menu). Skip the model for a `blocking-human` gate and for an empty reply (today's empty-answer retry). Leave every destructive option out of the criteria, so a reply meaning one maps to `none`: destructive means choosing it deletes, overwrites, closes, aborts, rolls back, discards work, overrides or skips a check, or accepts known gaps.

<!-- dm:questions gate-reply -->
```json
{"mapped": {"type": "choice", "instructions": "The user was asked the question in state and typed the reply in state. Which offered option does the reply choose?", "criteria": {"o1": "Option 1 label: its description, in shown order", "o2": "Option 2 label: its description", "none": "The reply does not plainly pick exactly one option: it modifies an option, adds conditions, explains in its own words, asks a question, or is ambiguous."}}}
```

questions.json: one criteria key per offered non-destructive option (o1..oN), keeping the shown order, plus `none`. State file `s1.txt`: `Question: {question}`, `Options: {N}. {label} ...`, `Reply: {verbatim reply}`, one per line. Budget 60000.

Apply: echo an `ok` answer other than `none` as `Did you mean: {option}? (decided-by: ...)`; act only after a yes. Otherwise today's handling runs.

## site: uat-reply

Eligible: every non-empty UAT reply in verify-work `process_response`, one call per reply. An empty reply is `pass`, no call.

<!-- dm:questions uat-reply -->
```json
{"bucket": {"type": "choice", "instructions": "Which result does the tester's reply give for this test?", "criteria": {"pass": "The expected behavior was seen, or the reply is a bare approval.", "skip": "The tester chose not to or cannot test it, and names no blocker.", "blocked": "A prerequisite prevents testing: a server, device, build or service is missing.", "deferred": "An idea for later or another phase, not a defect in the current work.", "issue": "Something is wrong, missing or broken now."}}, "severity": {"type": "score", "instructions": "If the reply reports a problem, how severe is it?", "criteria": {"cosmetic": "Visual only: color, font, spacing, alignment.", "minor": "Works but is slow, weird or slightly off.", "major": "Does not work, nothing happens, wrong behavior or missing.", "blocker": "Crash, error, exception, fails completely, unusable."}}}
```

State file `s1.txt`: `Test: {name}`, `Expected: {expected}`, `Reply: {verbatim reply}`, one per line. Budget 60000.

Apply: an `ok` bucket replaces the keyword match. An `ok` `issue` on a reply matching the deferred keyword list: ask the user once whether it is a gap or a deferred follow-up and record that answer (#1921). An `ok` `deferred` never writes a gap. `blocked` keeps `blocked_by` from the keyword table. An `ok` severity is used only when the result is `issue`. Write the `decided-by:` line into the test entry in the SAME write as the result and show `Recorded: {result}[, severity {s}] (decided-by: ...)`. The verbatim reply is stored as today. Per question, abstain or error falls back to the keyword lists (severity default major).

## site: inbox-type

Eligible: issues the heading rules leave untyped; PRs at "Cannot determine". One call for issues and one for PRs, each with its variant's questions. State file `n{number}.txt` per item: `Title: {title}`, a blank line, the whole body as fetched; ids `n{number}`.

<!-- dm:questions inbox-type.issue -->
```json
{"type": {"type": "choice", "instructions": "What kind of GitHub issue is this?", "criteria": {"unknown": "Cannot tell.", "feature": "A new capability.", "enhancement": "An improvement to an existing feature.", "bug": "Something broken.", "chore": "Maintenance, no user-facing change."}}}
```

<!-- dm:questions inbox-type.pr -->
```json
{"type": {"type": "choice", "instructions": "What kind of pull request is this?", "criteria": {"unknown": "Cannot tell.", "feature_pr": "Adds a capability.", "enhancement_pr": "Improves an existing feature.", "fix_pr": "Fixes something broken."}}}
```

Apply: show an `ok` type other than `unknown` as `Proposed type: {Type} (decided-by: ...)`. The item keeps today's classification for review, labels and closing: bodies are third-party text (EVAL2 E6b), so a proposal is never acted on (D19).

## site: inbox-fields

Eligible: issues typed under `review_issues`. One call per issue template, reusing the `n{number}.txt` state files; questions.json holds one `noul` question per required content field of that template.

<!-- dm:questions inbox-fields -->
```json
{"steps": {"type": "noul", "instructions": "Is the section 'Steps to reproduce' filled with real, specific content (not placeholder text, empty or vague)?"}}
```

Apply: an `ok` `yes` counts the field present; anything else you judge as today. A field counts as missing only on your own judgment, so no close rests on the model. Report per item `fields pre-filled: {K} (decided-by: ...)`.

## site: lesson-dedupe

Eligible, after Step 4: same-category cluster pairs Jaccard kept apart, neither skipped, whose combined source phases reach `graduation_threshold`, by centroid Jaccard high to low, at most 24 (say how many go unchecked).

<!-- dm:questions lesson-dedupe -->
```json
{"same": {"type": "noul", "instructions": "Do learning A and learning B state the same lesson, so promoting one covers the other?"}}
```

One call; state file `p{N}.txt` per pair: `Category: {c}`, `A: {title}` and body, `B: {title}` and body (first items). Apply: an `ok` `yes` is a same-as suggestion in the Step 5 report with its `decided-by:` line. In Step 6 ask "Treat as one cluster? [Y/N]" first; Y merges the pair for this run (earlier title, union of sources, `cluster_id` rule unchanged), then P/D/X/A if the threshold is met; N keeps both. Add-only (EVAL2 E4).

## site: prohibition-rescue

Eligible: Stage-1 candidates the inline Stage-2 pass dropped as routine; never kept items or canon drops (ADR-550 D6).

<!-- dm:questions prohibition-rescue -->
```json
{"kind": {"type": "choice", "instructions": "Is this must-NOT candidate routine engineering, a values, safety or ethics constraint, or a canon security rule?", "criteria": {"routine": "Normal correctness or hygiene, such as must not mutate input or leak a handle.", "values_safety": "Breaking it does something the author would object to on product, fairness, privacy or safety grounds.", "canon": "A standard security or compliance rule a dedicated tool owns, such as injection or generic GDPR."}}}
```

One call; state file `c{N}.txt` per candidate: `Requirement: {text}`, `Candidate: {must-NOT sentence}`. Apply: an `ok` `values_safety` joins the step 4 list after the inline-kept items, in Stage-1 order, as `rescued (decided-by: ...)`, resolved like any surfaced prohibition; add no field to the SPEC item (ADR-550 D5, D7c). Anything else stays dropped.

## site: probe-proposal

No questions block: the edge and UI probe CLIs ask, on the proposal pass only. An `unclassified` row may carry `model_proposal`: `labels` (`label`, `decided_by`), `categories`, `confirm_with.shapes` (edge) or `confirm_with.elements` (UI). Rows, statuses and coverage are unchanged; the merge pass never asks.

Show each label with its `decided_by` line. Confirm only by authoring the `confirm_with` override (requirement `shapes` in spec-phase, element `elements` in ui-phase) and re-running the proposal pass; never resolve or dismiss a row from a proposal alone. spec-phase `--auto` leaves the row unresolved (#1110) and logs the proposal; ui-phase `--auto` treats it as a hint: re-read the prose, author the override. An assumption-delta signal with `proposed_by: decision-model` carries a `decided_by` line to show.
