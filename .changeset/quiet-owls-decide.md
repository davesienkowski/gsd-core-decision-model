---
type: Added
pr: 0
---
**Opt-in `decision-model` capability and `gsd-tools decide`** — answers small closed questions (choice, yes/no, scored levels) through a configurable local backend, advisory and abstain-first: a low-confidence, malformed or unreachable result abstains with a reason and exit 0 so callers keep today's behavior. Off by default; enable with `gsd-tools config-set decision_model.enabled true` and `gsd-tools config-set decision_model.model <model-id>`. Loopback-only unless `decision_model.allow_remote` is set in your own `$GSD_HOME/.gsd/defaults.json`: that key and `decision_model.api_key_env` are user scope only, so a cloned repository's config cannot consent to remote egress or choose which secret is sent. An answer never gates a security or destructive action.
