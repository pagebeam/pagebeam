# Application evidence

Run from this directory with a built Pagebeam CLI. The example frontend always runs from this checkout. Its backend can run from source, an existing URL, a container image, or validated mock fixtures.

```sh
node ../../packages/cli/dist/main.js capture --environment source --target local --journey notes --json
node ../../packages/cli/dist/main.js capture --environment mock --target local --journey notes --json
```

The source and mock environments start their own backend and frontend, create disposable accounts, save a note through the browser, reload it, assert persistence, and capture desktop and phone views. Run them sequentially because they use the same ports. Already occupied addresses are refused.

For an existing backend, start `node backend.mjs` yourself, then select `--environment existing`. Pagebeam leaves that backend running.

For an image, build this directory's Dockerfile in your own CI, push it, and resolve its immutable digest. Add this environment using your actual digest:

```yaml
capture:
  environments:
    container:
      disposable: true
      backend:
        kind: image
        path: .
        compose: compose.yml
        service: api
        image: your-registry/notes@sha256:<resolved-digest>
        ready: http://localhost:4301/health
      frontend:
        path: .
        start: node frontend.mjs
        ready: http://localhost:4300
      fixtures: { version: notes-v1 }
```

Export `CAPTURE_IMAGE` with that same digest for the Compose file. The digest placeholder above intentionally fails validation until replaced. Pagebeam assigns the Compose project a unique run identifier and removes only that project's containers and volumes. Capture Compose files cannot declare external resources, fixed resource names, or host directory mounts.

## Selection

```sh
pagebeam capture --plan --base origin/main
pagebeam capture --environment source --target local --base origin/main
pagebeam capture --environment source --target local --journey notes
pagebeam capture --environment source --target local --all
```

`--base` selects journeys from the merge-base diff to HEAD, including both sides of renames and deleted paths. Journey paths and shared group paths are relative to the Git repository root. `--changed-files` accepts a JSON array of paths supplied by another tool. Explicit journeys override mapping. An empty selection produces an empty report without starting services.

`--plan` resolves selection without executing project code. `--purpose check` runs actions and assertions without screenshots. `--purpose capture` and the default `both` retain configured screenshots and assertion outcomes. Existing `shoot` behavior remains available.

`--config` selects an explicit JSON or YAML configuration file. Paths still resolve from `--cwd`, so a CI-generated configuration can live outside the checkout without changing source paths. Saved steps also support `press`, `type`, and a project-owned `verify` module. A verification module exports `async function(page, { env })` and throws when its assertion fails. Saved typing can use `{type: {valueEnv: NAME}}` for runtime test data. Exploratory callers cannot read environment variables or request arbitrary verification modules.

## Backend data

A backend image or directory does not provide a populated database. An environment can declare `fixtures.path`, `fixtures.version`, an optional `fixtures.restore` command, and `prepare` commands. Commands receive `PAGEBEAM_RUN_ID`, `PAGEBEAM_RUN_DIR`, and `PAGEBEAM_FIXTURES` when configured. Restore and preparation commands run from the configuration directory. Backend startup and mock validation run from the backend directory.

Mock fixtures must come from captured responses or match a project-owned schema. A mock environment requires a `validate` command, which runs before its server starts. This example's fixture shape belongs to its included notes API. `PAGEBEAM_FIXTURES` points to the mock's fixture file or directory.

Existing URLs require a backend revision. Source directories record their Git revision unless configured explicitly. Images require an immutable digest. Set `frontendRevision` for an already-running frontend; otherwise the frontend startup directory's Git HEAD is recorded. A frontend without either is recorded as unknown. Working-tree edits do not change HEAD; use an explicit revision label when capturing uncommitted work.

`requiredEnv` names variables that must exist before startup. `env` sets project runtime values; put credentials in the process environment rather than in configuration. Fixture commands must target the selected environment and must never restore over shared development data. Declare `disposable: true` only for data the run is allowed to modify.

## Exploration

```sh
PAGEBEAM_CLI="$PWD/../../packages/cli/dist/main.js" node caller.mjs
pagebeam capture --environment source --target local --journey notes --mode model
```

Model execution requires the existing `model` configuration and a provider that supports its text chat interface. It receives a bounded text observation and control selectors, then chooses validated browser actions. It does not receive raw screenshots. Browser screenshots remain available as artifacts for other consumers.

Each exploratory journey declares its goal, permitted navigation origins, actions, and budgets. Defaults are 50 actions and five minutes. Click, fill, and select require both `allowChanges: true` and a disposable environment. Origins constrain browser navigation, not every API request made by the application. Use an isolated application account and backend to enforce data access.

The session command exchanges JSON lines. It emits `ready` for each journey and viewport, accepts these requests, and finishes with a run report:

```json
{"id":1,"method":"observe"}
{"id":2,"method":"step","action":{"goto":"/notes"}}
{"id":3,"method":"step","action":{"expect":{"selector":"li.note","text":"Second note"}}}
{"id":4,"method":"step","action":{"shot":{"name":"notes"}}}
{"id":5,"method":"finish"}
```

Send one request at a time and wait for its response. `cancel` stops the whole run. Closing input before `finish` marks the journey incomplete. Errors include the request ID; browser step failures are retained in the report even if the caller continues. Login scripts must keep stdout reserved for the protocol.

Caller and model assessments are recorded separately from observed assertions. A passed run means execution completed without a recorded failure; it does not turn a model assessment into proof. Exhausted budgets produce an incomplete run.

## Evidence and comparison

Each run gets its own output directory containing `report.json`, `index.html`, and journey/viewport artifacts. Reports survive readiness, preparation, browser, and cleanup failures. Exit codes are 0 for passed or empty, 1 for failed, and 2 for incomplete runs or invalid invocation.

Use `--compare-environment` and `--compare-target` to run the same saved journeys against an independently prepared base frontend. The base environment must identify its frontend revision. `comparison.json` pairs capture checkpoints and marks unknown or differing fixture versions, viewport sizes, incomplete runs, or mismatched actions as incompatible. `--base` alone selects changes; it does not capture a baseline. For a source frontend, use `--compare-base origin/main` to prepare its baseline automatically from tracked source. `--baseline-install` accepts the project's dependency command and runs at the baseline repository root. Both revisions reuse this configuration and fixture backend. The output root contains a paired `index.html` gallery.

Configure `capture.mask` with sensitive element selectors and `capture.redactEnv` with additional secret variable names. Password and login inputs are masked automatically. Recording masks should use CSS selectors. Review application-specific sensitive data before sharing evidence.

The CLI does not upload files or post comments. Another tool can consume its JSON result, host the artifact directory, and publish its own review. A CI artifact download does not make screenshots publicly embeddable.

`review-adapter.py` demonstrates a review integration consuming captures and failures without posting anything. It returns revision, provenance, selection, local screenshot paths, and report/gallery paths. Its caller owns uploads and review publication.

The TypeScript entrypoint exports `capture`, `CaptureSession`, `explore`, `selectJourneys`, `changedFiles`, and `compareCaptures`. External drivers receive the same session methods used by the CLI.

The GitHub Action accepts `command: capture`, selection inputs, an environment and target, and optional comparison inputs. It uploads evidence after execution failures and exposes `report`, `gallery`, `directory`, and `artifact-url` outputs. The separate reusable reporting workflow can link the gallery on a PR without executing application code with its write token. See the root README for the two-job integration. Pin the action and reporting workflow to a reviewed commit or release.
