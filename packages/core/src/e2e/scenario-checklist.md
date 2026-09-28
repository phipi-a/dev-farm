# DEV-28 dogfood scenario

`scenario-checklist.json` is the machine-readable contract for this harness.

The deterministic test injects fake Linear, Docker, GitHub, SQLite state, tmux,
agent, workspace, and clock ports. Live provider execution is skipped unless a
host explicitly supplies its own provider composition; this subtree never reads
credentials or starts Docker, tmux, or Pi itself.

The scenario runs three tickets in parallel and verifies:

- each worker owns a distinct workspace, branch, container, and tmux identity;
- question and review feedback continue on the original worker;
- exactly one explicit merge occurs;
- every provider resource is cleaned up and each state record is destroyed; and
- Linear, GitHub, Docker, and state projections agree.
