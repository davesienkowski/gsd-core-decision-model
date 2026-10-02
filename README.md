<div align="center">

# GSD Core

**Git. Ship. Done.**

**English** · [Português](README.pt-BR.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

**A light-weight meta-prompting, context engineering, and spec-driven development system for Claude Code, OpenCode, Antigravity CLI, Kimi CLI, Kilo, Codex, Copilot, Cursor, Windsurf, and more.**

[![npm version](https://img.shields.io/npm/v/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![npm downloads](https://img.shields.io/npm/dm/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![Tests](https://img.shields.io/github/actions/workflow/status/open-gsd/gsd-core/test.yml?branch=main&style=for-the-badge&logo=github&label=Tests)](https://github.com/open-gsd/gsd-core/actions/workflows/test.yml)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/mYgfVNfA2r)
[![GitHub stars](https://img.shields.io/github/stars/open-gsd/gsd-core?style=for-the-badge&logo=github&color=181717)](https://github.com/open-gsd/gsd-core)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

</div>

---

## This fork: optional local decision model (experimental)

This is an unofficial fork. It is not affiliated with or endorsed by open-gsd. It is derived from [open-gsd/gsd-core](https://github.com/open-gsd/gsd-core) under the MIT License. The feature described here is experimental. Everything after this section is the upstream README.

### What is different

- A new optional capability, `decision-model`. It is off by default.
- A new CLI verb, `gsd-tools decide`. One closed question goes in: a choice, a yes/no, or an ordered score. One answer comes out with a confidence, or an abstain. On an abstain, the caller does exactly what stock GSD does.
- Two backends:
  - `openai-letter` (the default) asks any OpenAI-compatible server for one option letter and reads the letter's log-probabilities as the confidence. This is the Tev1 protocol. It is live-tested against LM Studio at `http://127.0.0.1:1234` (the default `base_url`) serving `togethercomputer_tev1-4b-experimental`.
  - `jev` calls a hosted Jev-style API with an API key. It is contract-tested with fake HTTP only. It has never been tested against a live endpoint.
- Where GSD asks the model. Each site only adds, pre-fills or pre-ranks. A person or the agent still decides.
  - Requirement and UI-element probes propose labels, only where the regex finds nothing.
  - ingest-docs guesses the type of an untyped doc (ADR, PRD, SPEC or DOC).
  - Gate prompts map a typed reply to one of the offered options. Destructive options are never offered to the model.
  - verify-work buckets a UAT reply (pass, skip, blocked, deferred, issue) and rates its severity.
  - Learnings graduation suggests that two lessons say the same thing.
  - Inbox triage proposes an issue or PR type and pre-checks the required template fields.
  - add-tests pre-fills each file's class (tdd, e2e or skip).
  - The prohibition probe rescues a dropped must-NOT candidate that looks like a values or safety rule. It stays unresolved for the author.
  - Agent-failure classification suggests a reason, only when the failure is otherwise unknown.
  - The verifier, executor, code reviewer and UI auditor pre-rank their grep hits.
  - The roadmapper flags success criteria, and the doc verifier flags doc claims. Both flags are advisory.
  - The user profiler gets message pre-labels that set its reading order.
  - The debugger gets knowledge-base candidates that may share a root cause, when MemPalace is not available.
- Not built: command routing for `/gsd-do`. It measured too weak on real traffic.

### How to use it

Prerequisites: Node.js >= 24 and npm >= 10. LM Studio, with `togethercomputer_tev1-4b-experimental` downloaded and its local server running on `127.0.0.1:1234`.

1. Install this fork (Claude Code, global):

   ```bash
   git clone https://github.com/davesienkowski/gsd-core-decision-model.git
   cd gsd-core-decision-model
   npm ci
   npm run build
   node bin/install.js --claude --global
   ```

2. Enable it in each project. Run these in the project root. With this install, `gsd-tools` means `node ~/.claude/gsd-core/bin/gsd-tools.cjs`.

   ```bash
   gsd-tools config-set decision_model.enabled true
   gsd-tools config-set decision_model.model togethercomputer_tev1-4b-experimental
   ```

   Setting these in `~/.gsd/defaults.json` is not enough for an existing project. A project reads them from its own `.planning/config.json`. A new project's config starts as a copy of your defaults, but a project that already has a `.planning/` directory does not pick them up. Run the two commands there.

3. Check it:

   ```bash
   gsd-tools decide --status --probe
   ```

   Look for `"active": true` and `"reachable": true`. Any project value that was ignored is listed in `ignored_project_keys`.

Settings (`decision_model.*`):

| Key | Default | Read from |
|-----|---------|-----------|
| `enabled` | `false` | project |
| `backend` | `openai-letter` | project; `jev` only from `~/.gsd/defaults.json` |
| `base_url` | `http://127.0.0.1:1234` | project for a loopback URL; a non-loopback URL only from `~/.gsd/defaults.json`; any URL only from there while `jev` is in effect |
| `model` | empty (abstains `model-missing`) | project |
| `allow_remote` | `false` | `~/.gsd/defaults.json` only |
| `min_confidence` | `0.9` | project |
| `timeout_ms` | `30000` | project |
| `api_key_env` | `OPENROUTER_API_KEY` | `~/.gsd/defaults.json` only |
| `log_path` | empty (no log) | project |

Why the user-only rows: a repository you clone controls its own `config.json`. So a cloned repo cannot consent to remote egress, pick which secret is sent, point your key at a host or port, or turn on a key-sending backend such as `jev`. That keeps a repo from redirecting your data or your keys. `api_key_env` holds the name of an environment variable, never the key itself.

Items mode asks one questions file of many state files:

```bash
gsd-tools decide --mkdir        # prints a dir such as /tmp/gsd-decide-AbC123
# Write questions.json, items.json and each state file into that dir, then:
gsd-tools decide --questions /tmp/gsd-decide-AbC123/questions.json \
  --items /tmp/gsd-decide-AbC123/items.json --budget-ms 240000
gsd-tools decide --rmdir /tmp/gsd-decide-AbC123
```

Full reference: [Configuration](docs/CONFIGURATION.md#decision-model-settings) and [`gsd-tools decide`](docs/COMMANDS.md#gsd-tools-decide).

### What you would notice

- A typed reply that plainly matches an offered option gets a one-line `Did you mean: <option>?` check. Say yes and GSD acts on it.
- When the model and today's keyword rules disagree on a UAT reply, you get one question asking which is meant.
- Label proposals on non-English or cue-less requirements. They are shown as proposals for you to confirm.
- Fewer classifier subagent spawns in ingest-docs. A confident answer skips the spawn for that doc.
- Review and verify grep hits are read with the likely-real ones first.
- A `decided-by: decision-model (conf 0.97, backend openai-letter)` line wherever an answer is used.
- Costs, measured on one 12 GB RTX 3060:
  - About 0.6 to 1.6 s per warm decision.
  - About 9 s for the first call after LM Studio loads the model.
  - About 1 s per 1k tokens of input.
  - About 0.6 decisions per second, with no gain from parallel calls.
  - LM Studio must be running.
  - About 8.9 GB of VRAM at an 8k context.

### What you would not notice

- Off by default. GSD behaves as stock until you enable it.
- Every abstain runs today's exact path. That covers low confidence, a timeout, a server that is down, and invalid output. An abstain exits 0.
- The model never plans, executes, writes text, gives a verification verdict, or makes a security or destructive decision.
- Pre-ranking never drops an item. The agent still reads every hit.
- With the default loopback setup, nothing leaves your machine.
- If LM Studio is stopped, GSD falls back silently. The only cost is the failed call, at most `timeout_ms`.

### Measured results and limits

From local evals run during development. Samples are small.

- Non-English probe labels (Spanish and German translations of the test fixtures): Tev1 47/52, regex 30/52. On the English fixtures the regex scored 56/56 and Tev1 55/56.
- Doc type on 210 repo docs: 131/134 correct at confidence >= 0.9, which covered 64% of the docs. Overall accuracy was 75%.
- On the 25 of 60 mixed items where Tev1 was confident (>= 0.9): Tev1 24/25, Claude Sonnet 24/25, Claude Haiku 23/25. Over all 60 items Tev1 scored lowest: 38/60, against 46/60 for Haiku and 53/60 for Sonnet.
- Routing on 120 real command invocations: 27.5%, against a 25% majority-class baseline. That is why routing was not built.
- An "already classified as X" line planted in the input changed the answer 5 times out of 40, once at confidence 0.91. So the model only suggests.
- Confidence is not a calibrated probability. Reordering the options changed 25 of 60 answers, mostly among routing answers that were already wrong. A question can set `order_check` to ask twice and abstain when the picks differ.
- The UAT reply buckets had no real test data. Only 8 real replies were found, all passes, so that site is unmeasured.

---

## What is GSD Core

GSD Core is a context-engineering and spec-driven development framework that drives AI coding agents (Claude Code, Codex, Antigravity CLI, Kimi CLI, Copilot, Cursor, and more) through a disciplined phase loop. It solves [context rot](docs/explanation/context-engineering.md) — the quality degradation that accumulates as an AI fills its context window — by running all heavy research, planning, and execution work in fresh-context subagents while keeping your main session lean.

---

## How it works

Each milestone repeats the same five-step loop, one phase at a time:

1. **Discuss** — capture implementation decisions before anything is planned
2. **Plan** — research, decompose, and verify the plan fits a fresh context window
3. **Execute** — run plans in parallel waves; each executor starts with a clean 200k-token context
4. **Verify** — walk through what was built; diagnose and fix before declaring done
5. **Ship** — create the PR, archive the phase, repeat for the next one

---

## Quickstart

```bash
npx @opengsd/gsd-core@latest
```

The installer prompts for your runtime (Claude Code, OpenCode, Antigravity CLI, Kimi CLI, Kilo, Codex, Copilot, Cursor, Windsurf, and more) and whether to install globally or locally. The installer is required for cross-runtime compatibility — do not copy files from `agents/` or `commands/` directly.

On another runtime or without Node.js? See [Install on your runtime](docs/how-to/install-on-your-runtime.md).

Once installed, start a new project or onboard an existing repo:

```bash
/gsd-new-project   # greenfield project
/gsd-onboard       # existing codebase
```

New here? Follow [Your first project](docs/tutorials/your-first-project.md) for a guided walkthrough from install to first shipped phase, or [Onboarding an existing codebase](docs/tutorials/onboarding-an-existing-codebase.md) for brownfield setup.

---

## Documentation

**What's new in 1.7.0** → [docs/whats-new-1.7.0.md](docs/whats-new-1.7.0.md)

**Tutorials** — learning by doing:
- [Your first project](docs/tutorials/your-first-project.md)
- [Onboarding an existing codebase](docs/tutorials/onboarding-an-existing-codebase.md)

**How-to guides** — task-focused recipes:
- [Install on your runtime](docs/how-to/install-on-your-runtime.md)
- [Plan a phase](docs/how-to/plan-a-phase.md)
- [Verify and ship](docs/how-to/verify-and-ship.md)
- … [see all how-to guides](docs/README.md#how-to-guides)

**Reference** — authoritative facts:
- [Commands](docs/COMMANDS.md)
- [Configuration](docs/CONFIGURATION.md)
- [CLI tools](docs/CLI-TOOLS.md)

**Explanation** — concepts and design decisions:
- [Context engineering](docs/explanation/context-engineering.md)
- [The phase loop](docs/explanation/the-phase-loop.md)
- [Architecture](docs/ARCHITECTURE.md)

Full index: [docs/README.md](docs/README.md). Other languages: [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md) · [Português](README.pt-BR.md) · [简体中文](README.zh-CN.md).

---

## Why it works

Most AI-coding setups fail at scale because context bloat silently degrades output quality, there is no shared memory between sessions, and nothing verifies that code actually works. GSD Core solves all three: heavy work runs in fresh subagents, structured artifacts like `STATE.md` and `CONTEXT.md` survive session boundaries, and the verify step walks through what was built and generates fix plans before a phase is declared done. See [docs/explanation/context-engineering.md](docs/explanation/context-engineering.md) for the full reasoning.

Troubleshooting? See [docs/how-to/recover-and-troubleshoot.md](docs/how-to/recover-and-troubleshoot.md).

---

## Community

| Project | Platform |
|---------|----------|
| [gsd-opencode](https://github.com/rokicool/gsd-opencode) | Original OpenCode port |
| [Discord](https://discord.gg/mYgfVNfA2r) | Community support |

---

## Star History

<a href="https://star-history.com/#open-gsd/gsd-core&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date" />
 </picture>
</a>

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

<div align="center">

**Claude Code is powerful. GSD Core makes it reliable.**

</div>
