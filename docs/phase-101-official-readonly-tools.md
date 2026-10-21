# Phase 101 — Expanded official fnOS read-only operations

Expands the Agent's fixed allowlist from the documented official fnOS Skill command reference. These commands are read-only and use hard-coded argv arrays; user text and model output cannot add CLI flags.

New Docker operations:
- Running container list, full container list (including stopped/created containers), aggregate Docker stats, and Compose project list.
- The distinction between running-only and all containers is explicit, avoiding a false claim that stopped containers do not exist.

New system and monitor operations:
- fnOS version, kernel version, host name, uptime, volume list, and all-volume detail.
- Memory, network, and disk monitoring snapshots.

Natural-language aliases route these requests through the existing rules-first Agent path without model calls. Tool definitions deny extra arguments, and all commands continue to use the reviewed CLI adapter with timeout, output cap, sanitized errors, and existing authentication profile.

Scope intentionally excludes container mutation, arbitrary Docker arguments, log-body retrieval, raw endpoints, and shell execution.

Validation: Node.js 26 unit, adapter argv, tool registry, and Agent-routing tests. No CLI binary or real NAS is invoked.
