# Phase 37 — Natural-Language Operations Coverage

## Goal
Expand the rules-first mobile Agent so common read-only fnOS and file-management requests work without configuring a model API.

## Direct routes
- fnOS installed apps, Docker image inventory, download tasks, CPU monitoring, storage pools, and current-user information.
- fnOS file listing for an explicit path.
- Agent file listing for an optional directory path, bounded UTF-8 text-file preview, and bounded recursive filename search.
- Preserve existing system, storage, network, process, photo, and routine file-write intents.

## Behavior
- Direct routes call only the corresponding registered tool and pass validated, schema-shaped arguments.
- No model request is made for these deterministic intents.
- Missing paths or unsupported requests return the existing bounded tool errors; no shell fallback is introduced.
- All added fnOS CLI operations remain read-only.

## Validation
Unit tests cover every new route, exact tool IDs and arguments, no-model behavior, and text preview path routing. The existing Node.js 24/26 CI matrix and FPK build remain required. No production NAS is accessed.
