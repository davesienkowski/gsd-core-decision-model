# Decision-Model Calls (optional capability)

The one call recipe for decision-model sites (CONTEXT D12, D24). Read lazily, only after `gsd_run decide --status` says the capability is active. Governing: CONTEXT D5, D7, D11, D14, D18, D19, D21-D25; ADR-1411, ADR-2619, ADR-4139, ADR-857.

## Block convention

Every decision-model site, prose or agent, follows these rules:

- Open marker on its own line: `<!-- decision-model: {site-id} -->`; close marker on its own line: `<!-- /decision-model -->`.
- The first words are the label `**Decision model (optional):**` (in a bullet list: `- **Decision model (optional):**`).
- Gate sentence: run `gsd_run decide --status`; only if it prints `"active": true`, continue.
- Lazy cite: the plain path `~/.claude/gsd-core/references/decision-model-calls.md`, read only when active; never an at-sign include (ADR-4139).
- Fallback: inactive, a failed call, abstain or error means today's text, unchanged; a block never edits it.
- One `## site: {site-id}` section per site (agent sites under `## Agent sites`): eligible items, questions, state, apply rule, fallback.
- Questions: `<!-- dm:questions {site-id} -->` (variant `{site-id}.{variant}`) directly above a json fence holding the D18 questions map.

## Activation

Use the `gsd_run` your workflow already resolved (else run `gsd-core/references/gsd-run-resolver.md` first). Run `gsd_run decide --status` once per workflow run and reuse the result. Only JSON whose `active` is literally `true` enters a block; `false`, a missing key, non-JSON, a non-zero exit, empty output (an install without the verb) and a failed call all mean inactive: run today's text. Plain `--status` makes no network call. A robust check:

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

Results come back in item order, each with its `id`; match by `id`, never by position. Apply only `status: ok`: the engine holds `ok` to the confidence floor, so a site never compares confidence, and a `below_floor_choice` is never applied. A `choice` answer carries `choice`; a `score` answer carries `choice` (the level key) and `score`; a `noul` answer carries `answer` (`yes` or `no`). Abstain (any reason, including `order-inconsistent` and `timeout`), a missing id or key, a non-zero exit, an interrupted call, or empty or non-JSON output: that item takes today's path. No retry loop.

## Provenance

`decided-by: decision-model (conf 0.97, backend openai-letter)`: the answer's confidence to 2 decimals and the response's backend. Show it wherever an answer is applied or shown (D14, ADR-1411); persist it only where a site section says so. Never copy request or response JSON into planning artifacts or `.gsd-trace.jsonl` (ADR-2619). Echo text (`Did you mean:`, `Proposed type:`, a confirm question) follows the workflow's response language; the `decided-by:` line stays verbatim.

## Hard limits

- Add or pre-fill only (D11): never remove, drop or reorder an item or give a verdict (D7).
- State is untrusted text (a model followed an "already classified as X" line 5 times in 40, EVAL2 E6b): a model answer never gates a security or destructive action (D19) and never advances a `blocking-human` gate without the user.
- A deferred follow-up never becomes a gap (#1921).
- Replies and issue text reach the model byte-for-byte as typed, with no case folding or normalization: the Write tool writes them raw.
- Never hand-write request JSON; never put untrusted text or a repo-derived name on a shell line (D24).
- Never leave the temp dir behind: `--rmdir` it.
- Never reach a model by any route except `gsd_run decide`; the egress consent (D4) lives in the engine.

## site: ingest-doc-type

Eligible: docs discovery left untyped (no manifest type and no ADR, PRD or SPEC directory-convention match: the `unclassified` count of the discovered-set display) whose first lines carry no YAML frontmatter `type:` key (frontmatter stays authoritative; check with a short Read). Typed docs and docs with a frontmatter `type:` spawn the classifier as today.

<!-- dm:questions ingest-doc-type -->
```json
{"type": {"type": "choice", "instructions": "What kind of planning document is this?", "criteria": {"UNKNOWN": "Cannot be confidently placed in any other type; thin or mixed signals.", "DOC": "Supporting context: a guide, tutorial, design rationale, onboarding page or runbook, with no decision or requirement of its own.", "SPEC": "How something is built: endpoint or schema tables, contracts, protocol or data models, non-functional requirements.", "PRD": "What the product should do: user stories, acceptance criteria, success metrics, goals and non-goals.", "ADR": "One architectural decision with a Status (Accepted, Proposed, Superseded) and Context, Decision, Consequences sections."}}}
```

Items: `{"id": "f{N}", "state_file": "{absolute doc path}", "sha256": true}` (f1, f2, ... in input order); no state file (the doc is the state, read whole). The criteria order is deliberate (EVAL2 E6a); no `order_check` (D19).

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

Apply, per file by id: an `ok` answer pre-fills that file's category, with its `decided-by:` line as the brief reason in the `present_classification` table. Abstain or error: classify that file as today. The approval in `present_classification` is unchanged and decides.

## site: gate-reply

Eligible: a typed Other or free-text reply to a prompt that offered options (gate-prompts consumers, questioning, discuss-phase text mode, the manager menu). Skip the model for a `blocking-human` gate and for an empty reply (today's empty-answer retry). Leave every destructive option out of the criteria, so a reply meaning one maps to `none`: destructive means choosing it deletes, overwrites, closes, aborts, rolls back, discards work, overrides or skips a check, or accepts known gaps.

<!-- dm:questions gate-reply -->
```json
{"mapped": {"type": "choice", "instructions": "The user was asked the question in state and typed the reply in state. Which offered option does the reply choose?", "criteria": {"o1": "1. {label}: {description}", "o3": "3. {label}: {description}", "none": "The reply does not plainly pick exactly one option: it modifies an option, adds conditions, explains in its own words, asks a question, or is ambiguous."}}}
```

questions.json: one criteria key per offered non-destructive option, `o{shown number}`, keeping the shown order, each description starting with its shown number and label, plus `none`. With no non-destructive option left, make no call. State file `s1.txt`: `Question: {question}`, `Options: {N}. {label} ...`, `Reply: {verbatim reply}`, one per line. Budget 60000.

Apply: echo an `ok` answer other than `none` as `Did you mean: {option}? (decided-by: ...)`; act only after a yes. Otherwise today's handling runs.

## site: uat-reply

Eligible: every non-empty UAT reply in verify-work `process_response`, one call per reply. An empty reply is `pass`, no call.

<!-- dm:questions uat-reply -->
```json
{"bucket": {"type": "choice", "instructions": "Which result does the tester's reply give for this test?", "criteria": {"pass": "The expected behavior was seen, or the reply is a bare approval.", "skip": "The tester chose not to or cannot test it, and names no blocker.", "blocked": "A prerequisite prevents testing: a server, device, build or service is missing.", "deferred": "An idea for later or another phase, not a defect in the current work.", "issue": "Something is wrong, missing or broken now."}}, "severity": {"type": "score", "instructions": "If the reply reports a problem, how severe is it?", "criteria": {"cosmetic": "Visual only: color, font, spacing, alignment.", "minor": "Works but is slow, weird or slightly off.", "major": "Does not work, nothing happens, wrong behavior or missing.", "blocker": "Crash, error, exception, fails completely, unusable."}}}
```

State file `s1.txt`: `Test: {name}`, `Expected: {expected}`, `Reply: {verbatim reply}`, one per line. Budget 60000.

Apply, one general rule: compute today's keyword bucket first (the lists in verify-work, unchanged).
- When an `ok` bucket EQUALS the keyword bucket, apply it silently, with its `decided-by:` line in the test entry as below.
- When they DIFFER in any direction, echo both and ask the user once which is meant: `Keywords say {keyword bucket}, the model says {bucket} (decided-by: ...); which is meant?` The user's answer is the final result. This covers deferred to pass, blocked to pass, issue to anything, and the #1921 deferred-versus-issue case (a model `issue` on a reply that matches the deferred keyword list: is it a gap or a deferred follow-up?).
- A model severity applies only when the final result is `issue`; otherwise ignore it.

A final `deferred` takes the deferred follow-up path and never writes a gap. A final `blocked` keeps `blocked_by` from the keyword table. Write the `decided-by:` line into the test entry in UAT.md in the SAME write as the result, never into the checkpoint output (present_test is byte-exact); a confirm question shows it, and `complete_session` lists each model-decided result with its line so the user can clarify. The verbatim reply is stored as today. Per question, abstain or error falls back to the keyword lists (severity default major).

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

Eligible: issues typed under `review_issues`. One call per issue template, reusing the `n{number}.txt` state files; questions.json holds one `noul` question per required content field of that template, keyed by the field name in lower case with every character outside `A-Za-z0-9_.-` turned into `_` (`Steps to reproduce` is `steps_to_reproduce`).

<!-- dm:questions inbox-fields -->
```json
{"steps_to_reproduce": {"type": "noul", "instructions": "Is the section 'Steps to reproduce' filled with real, specific content (not placeholder text, empty or vague)?"}}
```

Apply: display only (D24). The model never counts a field present or missing: you judge every field as today, and the score, the Missing list and any close rest on your judgment alone (issue text is third-party, EVAL2 E6b). Show per item `model check: {K} of {N} fields look filled (decided-by: ...)`, with the lowest confidence of those answers.

## site: lesson-dedupe

Eligible, after Step 4: same-category cluster pairs Jaccard kept apart, neither skipped, whose combined source phases reach `graduation_threshold`, by centroid Jaccard high to low, at most 24 (say how many go unchecked).

<!-- dm:questions lesson-dedupe -->
```json
{"same": {"type": "noul", "instructions": "Do learning A and learning B state the same lesson, so promoting one covers the other?"}}
```

One call; state file `p{N}.txt` per pair: `Category: {c}`, `A: {title}` and body, `B: {title}` and body (first items). Apply: an `ok` `yes` is a same-as suggestion in the Step 5 report with its `decided-by:` line. In Step 6 ask "Treat as one cluster? [Y/N]" first; Y merges the pair for this run (earlier title, union of sources, `cluster_id` rule unchanged), then P/D/X/A if the threshold is met; N keeps both. Add-only (EVAL2 E4).

## site: prohibition-rescue

Eligible: Stage-1 candidates the inline Stage-2 pass dropped as routine, collected after stages 1-3 have run for every requirement; never kept items or canon drops (ADR-550 D6).

<!-- dm:questions prohibition-rescue -->
```json
{"kind": {"type": "choice", "instructions": "Is this must-NOT candidate routine engineering, a values, safety or ethics constraint, or a canon security rule?", "criteria": {"routine": "Normal correctness or hygiene, such as must not mutate input or leak a handle.", "values_safety": "Breaking it does something the author would object to on product, fairness, privacy or safety grounds.", "canon": "A standard security or compliance rule a dedicated tool owns, such as injection or generic GDPR."}}}
```

One call, the only `node` run step 5.6 allows (D1 still holds for the recall itself); state file `c{N}.txt` per candidate: `Requirement: {text}`, `Candidate: {must-NOT sentence}`. Apply: an `ok` `values_safety` first goes through step 3's canon-referral rule (a canon item gets its breadcrumb and stays dropped). A survivor joins the step 4 list after the inline-kept items, in Stage-1 order, as `rescued (decided-by: ...)` and stays `unresolved` for the author to resolve, including under `--auto`; add no field to the SPEC item (ADR-550 D5, D7c). Anything else stays dropped.

## site: probe-proposal

No questions block: the edge and UI probe CLIs ask, on the proposal pass only. An `unclassified` row may carry `model_proposal`: `labels` (`label`, `decided_by`), `categories`, `confirm_with.shapes` (edge) or `confirm_with.elements` (UI). Rows, statuses and coverage are unchanged; the merge pass never asks.

Show each label with its `decided_by` line. Confirm only by authoring the `confirm_with` override (requirement `shapes` in spec-phase, element `elements` in ui-phase) and re-running the proposal pass; never resolve or dismiss a row from a proposal alone. spec-phase `--auto` leaves the row unresolved (#1110) and logs the proposal; ui-phase `--auto` treats it as a hint: re-read the prose, author the override. An assumption-delta signal with `proposed_by: decision-model` carries a `decided_by` line to show.

## Agent sites

Used by gsd-verifier, gsd-executor, gsd-code-reviewer and gsd-ui-auditor to pre-rank grep hits, and by the flag and recall sites that follow. The model only pre-ranks, pre-labels or flags: the agent reads every item and keeps every verdict (D7, D11). Inactive, abstain, a non-zero exit or unparsable output means continue exactly as the agent's own text says. Everything above applies. The one reordering allowed is the order in which the agent reads items it still reads in full.

### Calling from an agent

- Host: only an agent whose `tools` line holds Write and Bash hosts a block (D26); a block never adds a tool. An agent without Write gets no block and takes today's path.
- `gsd_run`: define it the way the agent already does for its other `gsd_run` calls (its included resolver or its inline launcher preamble). An agent with neither (gsd-ui-auditor) pastes the block from `~/.claude/gsd-core/references/gsd-run-resolver.md` at the start of every Bash call that uses `gsd_run`; each Bash call is a fresh shell.
- One call per scan step, as Sending says but with line slices (D27): `--mkdir`; one Write for `<dir>/questions.json`; one Write for `<dir>/items.json`; one items-mode call; `--rmdir`. No file is written per item. Zero items means no call.
- Ids: an item's id is its own counter `k`, from 1 in the agent's own order, never a line number: `h<k>` for grep hits, `t<k>` for truths and plan criteria, `c<k>` for doc claims, `kb<k>` for knowledge-base entries, `m<k>` for profile messages. A line number goes only into `lines` and `prefix`. Two items at the same file and line are one item, sent once. Match answers to items by id only, never by text or position.
- Items: each is `{"id": "<id>", "state_file": "<repo-relative path>", "lines": [start, end], "prefix": "<note>"}`. `state_file` is a project file, as found, relative to the project root; `lines` is the 1-based inclusive slice that holds the item and its context; `prefix` is fixed text: the words the site section gives (for a grep hit, one kind word the agent picks) plus a line number, never text copied from a file, a doc, a message or a hit. A prefix holds only ASCII letters, digits, space and `:-_()`, at most 200 characters (no quote, backslash, tab or line break). A path holding `"`, `\` or a control character is left out; that item takes today's path. Write the whole array with the Write tool, never through the shell. `decide` reads each slice raw and builds the request itself, so item text is never copied, quoted or put on a command line (ADR-1577, D24). An oversize or out-of-range slice abstains and the agent reads the item as today.
- Text held only in the agent's head (a truth it derived, a criterion it phrased) is written once with the Write tool, each single-line text on its own line, to `<dir>/text.txt`; each item is then a one-line slice of that file.
- Questions: fixed text; copy the site's questions block verbatim into `<dir>/questions.json`.
- Cap: at most 60 items per call, the first 60 in the agent's own order. Items beyond the cap count as abstained and are still read and judged. Use `--budget-ms 240000` and a Bash timeout of 300000. `order_check` is not used for `noul` questions.
- Safety (D19): a model answer never gates a security or destructive action. A secret or dangerous-function hit stays Critical whatever the answer.
- Provenance: an answer that is applied or shown carries its `decided-by:` line. A pre-rank run also records one run line: `decided-by: decision-model (conf <lowest ok confidence>, backend <backend>); pre-ranked <k> of <n> hits; all <n> read`.

Read the answers through this one-liner (a header with backend and model, then one line per id: id, status, answer or reason, `p_yes` or confidence), not as raw JSON:

```bash
node -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{try{const r=JSON.parse(s);console.log("backend="+r.backend+" model="+r.model);for(const x of r.results){const a=Object.values(x.answers)[0]||{};console.log(x.id+" "+a.status+" "+(a.answer||a.choice||a.reason)+" "+(a.p_yes!==undefined?a.p_yes:a.confidence))}}catch(e){console.log("unparsable")}})' < '<dir>/answers.json'
```

### Grep-hit pre-rank

Site `grep-rank`. When: after the grep step, before judging; zero hits means no call. One item per distinct hit, never a file per hit. For the `k`-th hit in grep order, at line `n` of `<path>`, with `<kind>` the kind of the pattern that matched, the item is `{"id": "h<k>", "state_file": "<path>", "lines": [max(1, n-5), n+5], "prefix": "grep kind: <kind> (match at line <n>)"}`: the engine reads the hit and 5 lines either side from the file, so no extra file read is needed and nothing is copied. `<kind>` is one word from the host's list, never the pattern or the matched text. gsd-verifier: `placeholder`, `empty-implementation`, `empty-data`, `empty-props`, `console-log-only`; gsd-executor: `empty-value`, `placeholder`, `todo`, `no-data-source`; gsd-code-reviewer: `secret`, `dangerous-function`, `debug-artifact`, `todo`, `empty-catch`; gsd-ui-auditor: `generic-label`, `empty-state`, `error-copy`. A hit in a file outside the project root is not sent. Question key `real`, type `noul`, fixed text by agent: gsd-verifier and gsd-executor `grep-rank.stub`, gsd-code-reviewer `grep-rank.review`, gsd-ui-auditor `grep-rank.copy`.

<!-- dm:questions grep-rank.stub -->
```json
{"real": {"type": "noul", "instructions": "Is this match a real stub left in shipped code: placeholder text, a TODO marker, or an empty or hardcoded value that reaches rendering or user-visible output with no other code path populating it with real data? A string literal or a comment can be a stub. Answer no only when real data replaces the value, or the match is a test helper, a type default or a false match."}}
```

<!-- dm:questions grep-rank.review -->
```json
{"real": {"type": "noul", "instructions": "Is this match a genuine instance of what its grep pattern looks for: a credential value written into the code, a TODO, FIXME, HACK, XXX, console.log or debugger left in shipped code, a call to a dangerous function, or a catch that swallows the error? A match inside a string literal or a comment counts. Answer no only for a false match, such as an unrelated identifier, a regex exec call or a fake value in a test fixture."}}
```

<!-- dm:questions grep-rank.copy -->
```json
{"real": {"type": "noul", "instructions": "Is this user-facing string a generic or unhelpful label in its context (for example a bare Submit, OK, No data or Something went wrong) rather than a specific, acceptable use?"}}
```

Scope: gsd-verifier sends only its stub-pattern hits (placeholder text, empty implementations, hardcoded empty data, empty props, console.log-only); its TBD, FIXME, XXX, TODO and HACK hits are not sent, because the debt-marker gate is lexical.

Order: `ok` answers of `yes` by `p_yes` descending, then abstained hits (including those beyond the cap) in grep order, then `ok` answers of `no` by `p_yes` ascending; ties keep grep order. The agent reads and judges every hit in every group. Verdicts, severities, Known Stubs and findings are the agent's own; never quote the model as evidence.

Run line, once and only when the call ran: VERIFICATION.md anti-pattern section (gsd-verifier), SUMMARY.md `## Known Stubs` when it lists real stubs, else a line of `## Self-Check`; never create an empty `## Known Stubs` (gsd-executor), REVIEW.md quick-depth findings (gsd-code-reviewer), UI-REVIEW.md Pillar 1 findings (gsd-ui-auditor).

### Criterion flag

Site `criterion-flag`. Host: gsd-roadmapper and its twin, once, after Step 5 has derived the success criteria of every phase and before Step 7 writes; zero criteria means no call. gsd-plan-checker would flag each `must_haves.truths` entry in Dimension 6, but it has no Write tool, so it gets no block (D26) and judges its truths as today.

The criteria exist only in the agent's head, so write them once with the Write tool to `<dir>/text.txt`, one criterion per line (a line break inside one becomes a space), in phase order then criterion order. One item per criterion, `k` its number from 1: `{"id": "t<k>", "state_file": "<dir>/text.txt", "lines": [k, k], "prefix": "success criterion"}`. Question key `observable`, type `noul`:

<!-- dm:questions criterion-flag -->
```json
{"observable": {"type": "noul", "instructions": "Can a user observe this criterion and does it resolve to pass or fail? Answer no for an implementation step (for example 'JWT library installed' or 'bcrypt installed') or a vague claim (for example 'works correctly', 'is properly set up', 'should feel good', 'looks reasonable')."}}
```

Gold: gsd-core/templates/phase-prompt.md:484-497 (Bad: vague acceptance criteria; Good: concrete, verifiable ones), gsd-core/templates/spec.md:64-69 (every criterion a PASS/FAIL checkbox), and the roadmapper Step 2 test (verifiable by a human using the application).

Use: an `ok` `no` is only a hint to re-apply that Test to that criterion; a criterion with any other answer is judged as today. Nothing is dropped, reordered or re-worded because of the model, and the wording stays the agent's. The return summary lists each criterion the agent rewrote after a flag with its `decided-by:` line.

### Doc-claim flag

Site `doc-claim-flag`. Host: gsd-doc-verifier and its twin, after Step 3 has extracted the claims (so `<skip_rules>` are already applied) and before Step 4. One item per distinct doc line that holds at least one candidate, `k` numbered from 1 in line order, `n` the line: `{"id": "c<k>", "state_file": "<doc_path>", "lines": [max(1, n-1), n+1], "prefix": "doc claim at line <n> (<kinds> in <where>)"}`. `<doc_path>` is the doc as given, `<kinds>` the candidate categories on the line, space-separated words from `file-path`, `command`, `endpoint`, `function`, `dependency`, and `<where>` is `fenced-block` or `prose`. The engine reads the line and one line either side, so the doc is not copied and the claim token never goes into the prefix. Zero candidates means no call. Question key `real_claim`, type `noul`:

<!-- dm:questions doc-claim-flag -->
```json
{"real_claim": {"type": "noul", "instructions": "Does this line hold a real claim about this repository (a path, command, endpoint, function or dependency the doc says exists here), rather than only an example, vendor quote, placeholder, template or version string?"}}
```

Use: an `ok` `no` only prompts a re-check of that line's candidates against `<skip_rules>`; a candidate is skipped only when a rule applies, and the verifier names the rule. Every remaining candidate gets today's filesystem check, which alone sets PASS or FAIL; the model never skips a claim or sets a verdict (D7). A flagged candidate that FAILs gains an optional `"advisory": "possible example or placeholder; decided-by: decision-model (conf X, backend Y)"` field. The counts, the order of `failures` (line order) and every other field are unchanged. Write no file outside `<dir>` for this call.

### Profile pre-label

Site `profile-prelabel`. Host: the profile-user workflow, which has Write and Bash; gsd-user-profiler has `tools: Read` and gets no block (D26). When: after profile-sample, with at least one message. `decide` reads only the project root or a `--mkdir` dir, so after `--mkdir` copy the sample in (paths only, no message text):

```bash
cp '<sample>' '<dir>/messages.jsonl'
```

`<sample>` is `output_file` of the profile-sample output. One item per message, the first 150 only (this site's cap, not 60), `k` its number from 1, which is also its line: `{"id": "m<k>", "state_file": "<dir>/messages.jsonl", "lines": [k, k], "prefix": "developer message"}`. Question key `dimension`, type `choice`, no `order_check` (a label only sets reading order):

<!-- dm:questions profile-prelabel -->
```json
{"dimension": {"type": "choice", "instructions": "Which profiling dimension does this developer message carry the strongest signal for?", "criteria": {"communication_style": "How the developer phrases requests, instructions and feedback to Claude.", "decision_speed": "How quickly the developer chooses among options or trade-offs Claude presents.", "explanation_depth": "How much explanation the developer wants with code: understanding versus speed.", "debugging_approach": "How the developer approaches problems, errors and unexpected behavior.", "ux_philosophy": "How the developer weighs user experience, design and visual quality against function.", "vendor_philosophy": "How the developer chooses and evaluates libraries, frameworks and external services.", "frustration_triggers": "What causes visible frustration, correction or negative signals toward Claude.", "learning_style": "How the developer prefers to understand new concepts, tools or patterns.", "none": "The message carries no signal for any of these dimensions."}}}
```

Use: read the answers through the reducer. With the Write tool, write `profile-labels.json` beside the sample: `{"labels": {"m<k>": {"dimension": "<choice>", "confidence": <c>}}}` for each `ok` answer other than `none`; ids, dimensions and confidences only, never message text. No such answer means no file. A label only orders the profiler's reading; it still reads every message and owns every count, rating and quote.

### KB recall

Site `kb-recall`. Host: gsd-debugger, Phase 0, only when MemPalace is absent; an empty or missing `.planning/debug/knowledge-base.md` means no call. One item per entry, newest first, at most 40 (`order_check` doubles the calls), `k` its number from 1 in that order: `{"id": "kb<k>", "state_file": ".planning/debug/knowledge-base.md", "lines": [start, end], "prefix": "symptoms: <summary>"}`. `lines` runs from the entry's `## ` heading to the line before the next heading or the file end; `<summary>` is your own one-line summary of the current symptoms, at most 150 characters, in the prefix character rule (Calling from an agent), never copied from the report or the file. Question key `match`, type `choice`, `order_check` true (a position-biased pick would put a wrong hypothesis first):

<!-- dm:questions kb-recall -->
```json
{"match": {"type": "choice", "instructions": "The state gives the current symptoms, then one prior resolved debug session. Does that session share a root cause with the symptoms, even if worded differently?", "order_check": true, "criteria": {"same_cause": "The prior session has the same root cause as the current symptoms.", "different_cause": "The prior session has a different or unrelated root cause."}}}
```

Use: see `debugger-semantic-recall.md`, Decision-model candidates.
