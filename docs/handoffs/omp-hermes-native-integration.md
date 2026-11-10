# Handoff: native OMP and Hermes agents (live validation)

Branch `claude/affectionate-tesla-ax4z2v`, base `d06c9f6b`, commits `38b8ef23` (integrations) and `5b0da2e4` (review fixes). 101 files, about 5k lines. No PR is open. Nothing is staged by this document.

Third-party source the code was written against: Oh My Pi (OMP) commit `f6d0dd7` (npm `@oh-my-pi/pi-coding-agent` 18.17.0) and Hermes commit `6b21d0564de0` (PyPI `hermes-agent` 0.19.0).

## 1. Status at a glance

Done (implemented, unit-tested against fakes, typechecked):
- Two new agent ids, `omp` and `hermes`, in the shared catalog, CLI backends, UI registry, docs.
- OMP runs through the existing `PiRpcBackend` via a flavor seam; Hermes runs through a new WebSocket gateway backend.
- Hermes profile picker chip in the new-session flow; profile persisted and reused on resume.
- Review fixes applied: OMP `max` thinking passes through the runtime, Hermes model switch refusals surface, Hermes undeliverable approve/clarify answers surface.

NOT verified: **nothing has run against a real `omp` or `hermes` binary.** The capture lane was blocked by the sandbox (execution of downloaded third-party code was denied). Every wire frame in tests and code is reconstructed from the third-party source at the commits above, not recorded. Also not run: lint, Windows/macOS, rendered UI (browser/device), `apps/website` cross-tree data test (environmental failure).

Treat the first live session as the point where reconstructed assumptions get falsified.

## 2. Decisions (approved contract) and where implemented

1. OMP is native `omp --mode rpc-ui`, own agent id `omp`, reuses `PiRpcBackend` through a flavor seam (no fork), not ACP.
   - `apps/cli/src/backends/pi/rpc/piRpcFlavor.ts`, `apps/cli/src/backends/pi/rpc/PiRpcBackend.ts`, `apps/cli/src/backends/pi/acp/backend.ts` (`buildOmpRpcArgs`, `createOmpRpcBackend`), `apps/cli/src/backends/omp/**`.
2. Hermes uses the canonical WebSocket gateway (`hermes-gateway-v1`, obtained via `hermes -p <profile> gateway attach --json`), not ACP, not legacy stdio `tui_gateway`.
   - `apps/cli/src/backends/hermes/gateway/{attach,HermesGatewayClient,HermesGatewayBackend,eventMapping}.ts`.
3. Hermes profile is chosen at session start, persisted, reused on resume; no in-session switching.
   - `apps/cli/src/backends/hermes/gateway/hermesProfile.ts`, `apps/ui/sources/agents/providers/hermes/{profile,uiBehavior,HermesProfileChip}.ts(x)`.
4. Happier only attaches to a Hermes gateway the user already runs. It never starts, restarts or stops one (no `--start`/`--recover`/`gateway run`; a test asserts the args).
   - `apps/cli/src/backends/hermes/gateway/attach.ts`, `attach.test.ts`.
5. OMP approvals arrive as `select` frames whose last option is `Deny` (no bridge extension). Mode mapping: default -> `always-ask`, safe-yolo -> `write`, yolo -> `yolo`.
   - `apps/cli/src/backends/pi/rpc/piExtensionUiRequest.ts` (`parsePiToolApprovalSelect`, `buildPiToolApprovalResponse`), `apps/cli/src/backends/pi/acp/backend.ts` (`buildOmpApprovalModeForPermissionMode`).
   - Also: read-only, plan and unknown modes map to `always-ask`; acceptEdits -> `write`; bypassPermissions -> `yolo`. A mode change restarts the child.

## 3. Architecture map

| Area | Files |
| --- | --- |
| Shared catalog | `packages/agents/src/{types,manifest,auth,localCli,models,sessionModes}.ts`, `providers/providerCliRuntime.ts` (omp: `~/.bun/bin`; hermes: `~/.local/bin`, `AppData/Local/hermes/bin`), `providers/omp/{thinking,index}.ts`, `providers/hermes/index.ts` (`HERMES_PROFILE_ENV`) |
| Pi flavor seam | `apps/cli/src/backends/pi/rpc/piRpcFlavor.ts` (commands RPC, resume flag, scrubbed env, ask opt-in, select approvals, model catalog source), `PiRpcBackend.ts`, `piExtensionUiRequest.ts` (adds `ask` method + approval select parsing), `rpc/types.ts`, `pi/models/piModelCatalog.ts` (thinking scale `'pi' \| 'omp'`) |
| OMP backend | `apps/cli/src/backends/omp/{index,runOmp}.ts`, `acp/runtime.ts`, `cli/{command,capability,detect,checklists}.ts`, `cli/auth/ompCliAuthSpec.ts`, `executionRuns/executionRunBackendFactory.ts` |
| Hermes backend | `apps/cli/src/backends/hermes/{index,runHermes}.ts`, `gateway/{attach,runHermesCommand,HermesGatewayClient,HermesGatewayBackend,eventMapping,hermesProfile,createHermesBackend,createHermesRuntime}.ts`, `cli/{command,detect,capability,profileList,checklists}.ts`, `cli/auth/hermesCliAuthSpec.ts` |
| Registration | `apps/cli/src/backends/catalog.ts` (both), `apps/cli/src/agent/executionRuns/registry/executionRunBackendRegistry.ts` (omp only; hermes has no execution-run support) |
| Metadata | `apps/cli/src/api/types.ts`: `ompSessionId`, `hermesSessionId`, `hermesProfileId`, `hermesProfileName` |
| UI | `apps/ui/sources/agents/providers/{omp,hermes}/**`, `agents/registry/{registryCore,registryUi,registryUiBehavior,providerLogoSvgXml}.ts`, `agents/providers/registry/providerSettingsRegistry.ts`, new-session hooks `components/sessions/new/hooks/useNewSessionAgentInputExtraActionChips.tsx` and `useNewSessionAgentInputPresentation.tsx`, translations `agentInput.hermesProfileChip.*` in 11 locales |
| Docs/website | `apps/docs/content/docs/agents/{omp,hermes}.mdx`, `meta.json`, `index.mdx`, `capabilities.mdx`, `docs/agents-catalog.md`, `apps/website/src/data/agents.ts` |

Env hygiene for OMP: the child never inherits `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_CONFIG_DIR`, `PI_PROFILE`, `OMP_PROFILE` (case-insensitive scrub, at construct and at spawn). Flavor `pi` scrubs nothing and is unchanged.

OMP launch args: `--mode rpc-ui --approval-mode <mode> [--thinking <level>] [--resume <id>]`, no `--tools`. After every spawn Happier writes `set_ask_dialog` to stdin; commands list uses `get_available_commands`; model catalog uses `get_available_models` (no injected extension).

### Hermes profile flow (UI to resume)

1. New-session UI: the Hermes chip popover fetches `cli.hermes` capability with `params.includeProfiles: true` (CLI side: `cli/capability.ts`, `cli/profileList.ts` parsing `hermes profile list` table output). Choice lives in the agent option state; none chosen = no env (Hermes' active profile).
2. Spawn: UI `buildSpawnEnvironmentVariables` (`apps/ui/sources/agents/providers/hermes/profile.ts`) sets env `HAPPIER_HERMES_PROFILE=<-p name>` (constant `providers.hermes.HERMES_PROFILE_ENV`).
3. CLI: `resolveHermesProfileBinding` (`gateway/hermesProfile.ts`) reads recorded metadata first, else the env (validated by `assertValidHermesProfileName`). Attach runs `hermes -p <name> gateway attach --json`.
4. Persist: on bind, runtime publishes metadata `hermesProfileId` (Hermes `endpoint.profile_id`, which is the profile HOME PATH, not the `-p` name) and `hermesProfileName` (the `-p` name; from the requested name, else snapshot `profile_name`, ignored if `custom`).
5. Resume: recorded metadata wins and the env is ignored; attach uses `-p hermesProfileName` and requires attach `profile_id === hermesProfileId`, otherwise a `profile_mismatch` error and no `session.resume` is sent. Session id metadata: `hermesSessionId`.

## 4. Validation already run

All via the repo executor from the repo root (`./apps/stack/bin/hstack-exec -- <cmd>`, required by `AGENTS.md`).

```bash
./apps/stack/bin/hstack-exec -- yarn workspace @happier-dev/agents typecheck
./apps/stack/bin/hstack-exec -- yarn workspace @happier-dev/protocol typecheck
./apps/stack/bin/hstack-exec -- yarn workspace @happier-dev/cli typecheck
./apps/stack/bin/hstack-exec -- yarn workspace @happier-dev/app typecheck
./apps/stack/bin/hstack-exec -- yarn workspace @happier-dev/cli exec vitest run src/backends/hermes src/backends/pi src/backends/omp src/backends/catalog
```

Results (reported by the lanes unless noted):
- Typechecks agents, protocol, cli, app: exit 0 (after `5b0da2e4`).
- CLI focused set above: 69 files / 628 tests pass (post-fix; independently re-run by the orchestrator before committing `5b0da2e4`).
- Wider earlier runs at `38b8ef23`: protocol 303 files / 2371 tests; ui (`sources/agents sources/components/sessions/new sources/text`) 163 files / 1151; agents 49 files / 475.
- Docs `yarn test` 42 pass (sweep lane); `apps/website` typecheck OK.

Known failures and gaps:
- `apps/cli/src/agent/localControl/createAttachedTerminalSupervisor.hosted.test.ts`: 2 tests fail (`descriptor_retry`, `descriptor_heartbeat`, "promise resolved true instead of rejecting"). They reproduce in isolation. No lane touched that file or directory, so they are probably pre-existing, but this is **not proven**. First live-session task: classify on the base commit in a separate worktree (the shared checkout must keep its branch):

```bash
git worktree add ../happier-base d06c9f6b
cd ../happier-base && yarn
./apps/stack/bin/hstack-exec -- yarn workspace @happier-dev/cli exec vitest run src/agent/localControl/createAttachedTerminalSupervisor.hosted.test.ts
```

  Same 2 failures on base = pre-existing, unrelated. Failing only on the branch = regression to investigate.
- `apps/website` vitest `src/data`: 2 environmental failures (sibling released/unreleased trees not found), so the new `hermes` "upcoming" entry cross-check did not run.
- Not run: lint, `apps/server`, `packages/tests`, full UI suite, Windows, macOS, rendered UI, live binaries.
- RED evidence is partial: OMP tests were written after implementation (RED shown afterwards by setting the omp flavor equal to pi: 6 of 9 failed); Hermes RED was "module not found" for new modules; fix-lane tests had real RED.

## 5. Live test plan (dev machine)

### 5.1 Setup

```bash
# OMP (runs on Bun; binary normally lands in ~/.bun/bin)
bun add -g @oh-my-pi/pi-coding-agent     # or follow https://github.com/can1357/oh-my-pi (brew also works if offered)
omp --version                            # expect omp/18.17.0 or newer
omp                                      # run once interactively and sign in / set a model provider key

# Hermes (follow https://github.com/NousResearch/hermes-agent for the installer)
hermes --version                         # source read was 0.19.0
hermes setup                             # or configure a model provider key per its docs
hermes profile list                      # note the exact output; the UI parses this table
hermes profile create second             # a second profile "B" (check `hermes profile --help` if flags differ)
hermes gateway --help                    # find how YOU start a gateway; Happier never does
```

Start your own Hermes gateway for the profile under test (command per Hermes docs), in a separate terminal you control. To test the "no gateway" case, run Happier first with it stopped.

Run Happier from this checkout (per `CONTRIBUTING.md`, repo-local mode, wrapper in `apps/stack`):

```bash
git switch claude/affectionate-tesla-ax4z2v   # in your own clone, not the shared agent checkout
yarn && yarn build
yarn cli:activate        # puts hstack/happier on PATH from this checkout
yarn auth login          # once
yarn tui                 # dev stack (server + UI + daemon) with logs; or `yarn dev`
yarn logs -- --component=daemon --lines 200 --no-follow   # daemon logs when a spawn misbehaves
```

Terminal entry points: `happier omp` and `happier hermes` (also startable from the UI new-session screen). Docs for the stack: `apps/docs/content/docs/self-hosting/repo-local.mdx`.

### 5.2 OMP scenarios

For each, note actual frames from the daemon/session logs.

1. Start: `happier omp` or UI new session with agent Oh My Pi. Expect session ready, model list populated (from `get_available_models`), slash commands listed (`get_available_commands`).
2. Stream: send a prompt; expect streamed text, tool cards, a completed turn.
3. Approvals (default = `--approval-mode always-ask`): ask it to write a file and run a shell command. Expect an approval card titled from "Allow tool: <name>". Approve once: tool runs. Deny: tool refused, turn continues. Approve-for-session (if offered): later calls of that tool skip the prompt. Confirm the label strings OMP actually emits match what is parsed (`Approve`, `Approve Once`, `Approve <subject> for this session`, `Deny`).
4. Modes: switch to safe-yolo (writes auto-approved, exec asks) and yolo (nothing asks). Confirm the child restarts and the session continues.
5. Ask tool: prompt that triggers OMP's ask tool; expect a structured question UI (from `ask`/non-approval `select`) and the answer reaching OMP.
6. Thinking: set levels low..xhigh and `max` from the UI picker (for omp the catalog offers distinct XHigh and Max options, `apps/cli/src/backends/pi/models/piModelCatalog.ts:61`; pi keeps a single "Max" that maps to `xhigh`). Confirm `set_thinking_level` carries `max` (not folded to `xhigh`) and `get_state` echoes it.
7. Model switch: change model mid-session; confirm `set_model` applied and the UI reflects OMP's state.
8. Slash commands: run one from the list.
9. Abort and steer: abort a running turn; send a steering message mid-turn.
10. Resume: end the session, resume from Happier. Argv should contain `--resume <ompSessionId>`. Verify OMP resolves the bare id and `get_state.sessionId` matches (finding 6.1).
11. Env isolation: with `PI_CODING_AGENT_DIR=/tmp/pi-dir` exported in the daemon environment, start an omp session; confirm (for example via `/proc/<pid>/environ` or `ps eww`) the omp child has none of the five scrubbed vars, and that Pi sessions still receive theirs. Confirm omp state lands in OMP's own dir, not Pi's.

### 5.3 Hermes scenarios

1. No gateway running: start a Hermes session. Expect a clear user-facing error from the `gateway attach` exit code (2..7 mapped in `attach.ts`), no gateway started by Happier (check process list).
2. Gateway running: session starts, streaming text and reasoning appear, tool activity shown, usage updates.
3. Approval: trigger a tool needing approval; expect once / session / deny choices only from those Hermes offers; the tool proceeds or is refused accordingly. Check an undeliverable answer is shown (stop the gateway between prompt and answer).
4. Clarify: trigger a clarifying question (single and multi-select); answer reaches Hermes (multi = JSON array string).
5. Interrupt and steer: interrupt a running turn (`session.interrupt`); steer mid-turn (`session.steer`).
6. Model switch: change model; confirm applied. Provoke `confirmation_required` (a model change Hermes gates): expect a visible error and NO model change in the UI; `deferred` should read as "applies next turn".
7. Usage/compact: verify token usage events; `/compact` via compaction.
8. Profiles: open the chip popover; expect "Active profile" plus the profiles from `hermes profile list` (fresh fetch each open, up to 10 s). Start a gateway for profile B, choose B, start a session; confirm spawn env `HAPPIER_HERMES_PROFILE=B`, attach with `-p B`, and metadata `hermesProfileName`/`hermesProfileId` (profile home path) recorded. Resume it: attach uses `-p B`, `profile_id` matches; with B's gateway down it fails with a clear error and never falls back to the active profile. Also check `-p default` is accepted if the picker offers it.
9. Gateway restart mid-session: restart your gateway; the next prompt should reattach and `session.resume`. A turn running during the drop is expected to fail locally (known gap 6.3).
10. `code_sha` drift: run a gateway older/newer than the installed `hermes` source (or edit and reinstall without restarting the gateway); expect the "restart your Hermes gateway" message, not a crash.

### 5.4 Record real frames and replace reconstructed fixtures

Reconstructed frames live in:
- OMP: `apps/cli/src/backends/pi/rpc/PiRpcBackend.omp.test.ts` (fake JSONL child).
- Hermes: `apps/cli/src/backends/hermes/gateway/fakeHermesGateway.testkit.ts`, with `HermesGatewayClient.test.ts`, `HermesGatewayBackend.test.ts`, `eventMapping.test.ts`, `attach.test.ts`, `cli/profileList.test.ts` (table sample).

Capture, then replace with provenance-pinned recordings (record the omp/hermes version and commit alongside):

```bash
# OMP: raw rpc-ui stdin/stdout, in a sandboxed HOME
HOME=$(mktemp -d) omp --mode rpc-ui --approval-mode always-ask 2>&1 | tee omp-rpc-ui.jsonl
# then send JSONL commands by hand: {"type":"get_state"} {"type":"get_available_commands"} {"type":"set_ask_dialog","enabled":true} {"type":"prompt","message":"hi"}
# Hermes
hermes -p <profile> gateway attach --json | tee attach.json      # ticket/endpoint; do not commit the ticket
hermes profile list | tee profile-list.txt
```

For the WebSocket, connect with the ticket from `attach.json` using any ws client and log both directions. Redact tickets, keys and home paths before committing. Also check `HERMES` gateway `ready`/`client.capabilities`/`runtime.describe` replies against `HermesGatewayClient.ts`.

## 6. Open findings and deferred items

Things the live run is most likely to break (assumptions from source only):
1. OMP resume by bare id: `apps/cli/src/backends/pi/rpc/PiRpcBackend.ts` `resolveSessionFileForSessionId` only searches env-derived pi dirs, which are scrubbed for omp, so omp never passes a session file; it relies on OMP resolving `--resume <id>` (it may switch cwd or prompt if the project dir is missing). Fix if it fails: publish `get_state.sessionFile` and pass it to `--resume`. (Deferred in `5b0da2e4`.)
2. OMP approvals are text-only: the permission handler is keyed by the `select` request id with `toolName` parsed from "Allow tool: X" and input `{prompt}`; no structured tool args, no link to the tool event. A non-tool `select` ending in "Deny" during a turn would be misread as an approval (accepted trade-off of decision 5).
3. Hermes reconnect is on demand only (next prompt); no `events.since` replay; a turn running during a drop is failed locally though Hermes continues; a session already running at resume is not re-presented as in flight. Slash commands: none published except `/compact`; no images, no reasoning config, no queue controls.
4. OMP protocol v1 only (no `negotiate_protocol`): oversize frames are shrunk by OMP (strings/arrays elided, max frame about 1 MiB), so large tool output can look truncated; not a parse failure.
5. read-only and plan modes map to `always-ask` and are not enforced read-only (OMP has no stricter mode); documented in `apps/docs/content/docs/agents/omp.mdx`.
6. OMP `max` thinking: runtime now passes `max` through (fixed in `5b0da2e4`), but `HAPPIER_OMP_THINKING_LEVEL` still has no UI producer (`packages/agents/src/providers/omp/thinking.ts`; dormant-consumer concern from review). Decide: add a UI producer or delete the env path.
7. Hermes profile list is parsed from human table output (`apps/cli/src/backends/hermes/cli/profileList.ts`; Hermes has no `--json` for it). Brittle to format changes and Windows console glyphs; failure shows an error row. Display names with parentheses can yield a wrong id (invalid ids are dropped, never passed to `-p`).
8. Windows: candidate `AppData/Local/hermes/bin` in `packages/agents/src/providers/providerCliRuntime.ts` is home-relative, not `%LOCALAPPDATA%` (all providers share this style; rejected as a per-provider fix). `.exe` resolution and spawn via `resolveWindowsCommandInvocation` unvalidated on Windows/macOS.
9. Hermes: `gateway.ready` `session_authority` is ignored (absent means loud RPC errors); `approved_execpolicy_amendment`/`for_session` degrade to "session"; `yolo` is not passed to Hermes (approvals always go through Happier's handler); `session.create` source tries `tui` then `cli` from `runtime.describe`. Early `session.info`/`notice` events before the snapshot id is adopted are dropped (review finding rejected: create id is unknowable pre-response).
10. Unverified live specifics: OMP approval title and labels, `get_available_models` shape (`data.models[]`), `get_state` fields; Hermes `client.capabilities` on the canonical socket (tolerated if absent), `message.complete` admission id, `session.info` revision/generation, approval `edit` shape, `model.options` strings vs `session.mutate` model payload.
11. Cosmetic: error strings in `PiRpcBackend` still say "Pi ..." for omp; compaction provider label and connected-service runtime-auth classification say `pi` for omp; `omp/index.ts` uses a cast to inject `flavor`; `PiRpcFlavor.id` and `agentId` are redundant; `PI_CONFIG_FILES` is not scrubbed (negligible). Direct sessions and transcript import are not done for omp; hermes has no execution-run registration.
12. Docs and website: `omp.mdx` and `hermes.mdx` still say "ships in the next Happier version" (appropriate until release). `apps/website/src/data/agents.ts`: `ohMyPi` and `hermes` are `upcoming` (only `shipped|upcoming` exist). Logos are neutral monograms. Hermes docs do not mention the `HAPPIER_HERMES_PROFILE` env var.
13. UI chip not seen rendered; profile chosen is validated only at attach time; selecting a different machine after choosing keeps the choice (a profile absent there fails at attach with a clear error).
14. Compatibility: `packages/protocol` unchanged (`AGENT_PROVIDER_IDS_V1` is a direct-sessions subset); no wire enum changed, so mixed-version behavior was not exercised. Metadata gained optional fields only.

## 7. Suggested next steps, in order

1. Classify the 2 `createAttachedTerminalSupervisor.hosted` failures on `d06c9f6b` (section 4).
2. Run section 5 live; capture frames; fix whatever the reconstruction got wrong at the canonical owner (`PiRpcBackend`/flavor, `HermesGatewayBackend`/`eventMapping`), test-first.
3. Replace reconstructed fixtures with recorded, version-pinned ones (5.4).
4. Resolve findings 6.1 and 6.6; decide on 6.2.
5. Run the repo gates before any PR (per `AGENTS.md`): package typechecks (agents, protocol, cli, app, plus docs/website), relevant vitest slices through `./apps/stack/bin/hstack-exec --`, lint if the repo has a lane, Windows/macOS smoke for CLI spawn paths if available, and a `happier-review` pass (`.agents/skills/happier-review`) at the integration boundary. Check whether the 0.2 to 0.3 port skill (`.agents/skills/happier-port-0-2-to-0-3`) applies to this branch's line.
6. Squash or reword the WIP checkpoint `38b8ef23` (its subject says "WIP checkpoint") before opening a PR; none exists yet. Delete this handoff file before merging.
