# pagebeam

Docs that keep up with your product.

pagebeam checks each page of your docs against the product it describes. It
says how sure it is, and opens a pull request with the fixes it can make. It
is open source and runs in the repository you already have.

Full documentation: https://docs.pagebeam.dev

## Application evidence

`pagebeam capture` discovers review states or runs saved application journeys, checks visible outcomes,
and writes screenshots, a structured outcome, and a Markdown table. Another tool can
consume the result and publish its own review. Capture requires no GitHub token.

```sh
pagebeam capture --plan --base origin/main
pagebeam capture --environment ci --target ci --base origin/main --json
pagebeam capture --environment ci --target ci --journey checkout --journey settings
```

Configure an existing backend URL, a pinned image with Compose, a source directory,
or a validated mock API. Prepare test data separately from starting the backend.
Journeys can follow saved steps, accept actions from another tool over the session
protocol, or explore a configured goal using your model provider.

Changed-file selection traces affected routes through component dependencies in both revisions.
With discovery and a model enabled, automatic review identifies visible changes and learns browser
actions without saved journeys. Static mode runs matching screenshot checkpoints and exits incomplete
before startup when their coverage is unknown. Docs and CI changes skip capture.
`--all` and named journeys request manual runs without claiming affected-screen coverage.

See [the runnable capture example](examples/capture/README.md) for all backend
sources, test data, exploratory limits, the session protocol, and optional base
captures. Existing `pagebeam shoot` workflows remain available.

## Try it

Run two commands in the repository that holds your docs:

```
npx pagebeam init
npx pagebeam check
```

`init` looks at the repository and asks you to confirm what it found: where
your pages are, and which application they describe. Each question comes with
its answer filled in, so most take one keypress. When nobody can answer, in a
pipe or a CI job, it writes what it found and says what it could not work out.

`init` writes one file. `check` only reads and reports. Nothing is sent
anywhere.

If your product lives in another repository, check out both side by side and
point the config at the other one:

```yaml
docs:
  root: ../docs/content
apps:
  - name: dashboard
    path: .
```

## In CI

Add one workflow to the product repository. It runs when the product changes,
which is when the docs start to go wrong.

```yaml
name: docs drift
on:
  pull_request:
  push:
    branches: [main]

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: pagebeam/pagebeam@v1
        with:
          docs: your-org/docs
          token: ${{ secrets.PAGEBEAM_TOKEN }}
```

The action checks out every repository inside the workspace at
`<owner>/<name>`, with full history, and runs pagebeam from the docs, where
the config lives. Repositories with the same owner sit next to each other, so a
config that says `path: ../dashboard` works the same on a laptop and in CI. For
a repository with another owner, the path goes through its owner:
`../../other-org/dashboard`. A later step in the same job finds this
repository at `$GITHUB_WORKSPACE/<owner>/<name>`, not at the workspace root.

| Input           | Meaning                                                                          | Default                |
| --------------- | -------------------------------------------------------------------------------- | ---------------------- |
| `docs`          | The docs repository, as owner/name, when it is not this one                      | this repository        |
| `products`      | Other product repositories to check out, one owner/name per line                 | none                   |
| `command`       | `check` to report, `fix` to propose, `capture` for screenshots                                              | `check`                |
| `profile`       | `observe`, `enforce` or `enforce-all`                                            | `observe`              |
| `publish`       | With `fix`, open or update the pull request                                      | `false`                |
| `build`         | Build the docs site first: `auto`, `true` or `false`                             | `auto`                 |
| `token`         | Reads the other repositories and opens the pull request                          | the job's own token    |
| `model-key`     | Your model provider's key, as a secret                                           | none                   |
| `model-key-env` | The variable your config's `model.apiKeyEnv` names                               | `OPENAI_API_KEY`       |
| `version`       | The pagebeam release to run                                                      | the pinned source      |

The job's own token only reaches this repository. To read another repository
or open a pull request in it, pass a token that can: a GitHub App installation
token is the narrowest. To publish in this repository, give the job
`contents: write` and `pull-requests: write`.

`examples/` has workflows for a product repository, a docs repository and a
pull request gate.

## Checks

| Check          | Finds                                                                          | Default |
| -------------- | ------------------------------------------------------------------------------ | ------- |
| `links`        | A link to a route or file that does not exist                                  | on      |
| `configKeys`   | A setting the docs describe that no example config declares                    | on      |
| `openapi`      | An endpoint the docs describe that the spec lacks, and endpoints no page describes | on  |
| `strings`      | A control the docs name that the application no longer has                     | off     |
| `moved`        | Code that changed under a page that did not change with it                     | off     |
| `undocumented` | A screen of controls the docs never mention                                    | on      |

`strings` and `moved` compare today's code with an earlier revision, and stay
off until you turn them on. `undocumented` reads the application, not its
history. Its findings are always `review`, so it never fails a build.

## Standing

A finding claims only what its evidence supports.

**proven**: the source of truth says so. The built site has no such route. A
control was in the application at a known revision and is gone now.

**review**: worth a look, but not proof. pagebeam could not find it, which
does not mean the product lacks it. A label may be built at runtime, or live
in code no parser reads.

Only `proven` findings can fail a build, and only under an enforcing profile.

## Usage

```
pagebeam init                          write a config by looking at the repository
pagebeam check                         report everything, block nothing
pagebeam check --profile enforce       block on proven findings this change introduced
pagebeam check --profile enforce-all   block on every proven finding
pagebeam fix                           say what it would propose
pagebeam fix --publish                 open or update the pull request
pagebeam check --build                 build the docs site first, as its project does
```

With `--build`, pagebeam recognises the docs site the way a hosting platform
does, from the files and packages its framework leaves behind, and runs the
project's own build script. Missing dependencies are installed from its
lockfile. Links are then checked against the pages it built. This runs the
site's own code, so it happens only when asked for. A build that fails exits
`2`. `--build=auto` builds only a docs site of its own whose framework is
recognised, and says why when it does not build.

Exit `0`: nothing blocks. `1`: a proven finding blocks. `2`: the answer cannot
be trusted, because nothing was read or a requested check could not run.

## Proposals

A check can prove a page is wrong without knowing what the page should say.
If you name a model provider, pagebeam asks it once about each of those
findings, with the page and the evidence it already has.

Any endpoint that speaks the OpenAI chat completions API works: a provider, a
gateway in front of several, or a router on your machine. pagebeam ships no
provider code. It never sees your key, only the name of the variable that
holds it. Use `headers` if a provider needs more than a bearer token. Set
`enrich: false` to keep the provider in the config but stop asking it.

If your project keeps writing guides for its docs, list them under `skills`.
pagebeam passes them to the model as they are, after its own rules on how to
answer and what not to invent. They cannot override those rules.

```yaml
model:
  skills:
    - docs/writing-style.md
    - docs/TERMS.md
```

If a listed file cannot be read, the run stops.

### What leaves your machine

By default: the docs page, the finding and its evidence.

With `sendSource: true`, pagebeam also sends the source files a control was
found in. That is your product's code, so it is off unless you turn it on. The
output names every file sent. A file that looks like it holds a credential is
held back and reported instead.

```yaml
model:
  sendSource: false # the default
```

### What is refused

Every draft is checked again before it is proposed. The checks run on the
page the model wrote. If they still find what it was asked to fix, or find
something new on that page, the draft is refused. A draft that comes back
unchanged, shorter than half the page, or missing links and code the page
had, is refused too.

Every draft is marked as written by a model. A pull request that contains one
opens as a draft. Set `propose.draft` to decide this yourself.

## Configuration

`pagebeam.config.yaml` sits next to your docs. Paths are relative to the
folder you run pagebeam in.

```yaml
docs:
  root: docs                    # where the pages are
  include: ['**/*.{md,mdx,markdown,astro}']
  buildDir: dist                # the built site, if there is one
  routeBase: /docs              # if the site serves these pages under a prefix

history:
  sinceDays: 30                 # how far back to compare

apps:                           # every application the docs describe
  - name: dashboard
    path: ../dashboard
    include: ['**/*.{vue,ts,tsx,js}']
    envFiles: ['.env.example']
    openapi:
      spec: ../dashboard/openapi.yaml
    url: http://localhost:3000  # optional: open it and read what it shows
    routes: ['/', '/settings']
    auth:
      script: ./.pagebeam/login.mjs
      confirm: 'text=Sign out'

checks:
  strings: { minConfidence: 0.4 }
  moved: {}

model:
  baseUrl: https://api.openai.com/v1   # or a gateway, or one on this machine
  name: gpt-4o
  apiKeyEnv: OPENAI_API_KEY

propose:
  branch: pagebeam/drift
  base: main
  commitPrefix: docs        # the type every commit and the title use
```

pagebeam checks every setting. A setting it does not know is an error.

## Coverage

Reading files shows every control the application declares. Opening a running
copy shows what a user sees, including labels built at runtime, but only on
the pages you tell it to open.

pagebeam does both where it can, and each finding says which one it used. A
running copy can prove a control exists. It cannot prove one is gone, because
a page nobody opened shows nothing.

pagebeam reads Vue, React, Svelte, Astro, HTML and server templates with each
framework's own compiler. It searches anything else as plain text, and the
finding says so.

## Before-and-after PR screenshots

Configure one capture environment and saved journeys, then compare its frontend against a Git
revision. Pagebeam prepares a temporary baseline snapshot, starts each revision in turn on the same
address, and runs the same actions and requested viewports against both. Your checkout and branch stay in
place. Both revisions use the configured backend and fixture contract.

```sh
pagebeam capture --environment ci --target ci --compare-base origin/main \
  --baseline-install 'npm ci' --json
```

`--compare-base` also supplies the changed-file selection base unless `--base` is given separately.
Use `--all` or named journeys to override selection. Capture defaults to the `desktop` viewport.
Request `--viewport phone`, repeat `--viewport` for named sizes, or use `--viewport all` explicitly.
`--all` selects journeys; it does not enable mobile viewports. `--plan` never prepares a baseline or executes
its installation command. Explicit `--compare-environment` and `--compare-target` remain available
for independently provisioned deployments.

`--baseline-install` is optional and runs from the baseline repository root. Supply your project's
own command: npm, Composer, pip, Bundler, Cargo or any other tool available in the job. Pagebeam does
not install language runtimes, create application accounts, infer paid access, or invent fixtures.
Its CLI runs on Node.js 22; the application can use any language. The frontend start command and
readiness URL come from the selected capture environment. Baselines are archived tracked source;
untracked files, local dependencies and external submodule contents are not copied.

The default output is a Markdown before-and-after table (`report.md`), portable structured metadata
(`outcome.json`), JSON run reports, and screenshot files. JSON CLI output also includes the portable `outcome` object.
Add `--html` to generate HTML as well.
Unmapped changes and incomplete comparisons remain labelled in the outcome and reports.

Capture outcomes, renderers and publishers are separate interfaces. `Outcome` carries status and
file evidence; `CaptureOutcome` also carries revision and screenshot pairs. An `OutcomeRenderer`
chooses the presentation, and an `OutcomePublisher` receives the complete outcome and returns published evidence URLs and an
optional report URL. The
`writeOutcome` API accepts custom outcome kinds, renderers and publishers. Markdown and HTML
renderers consume the same data, so a service can render saved outcomes without rerunning capture.

### Declarative setup

Share saved journeys between local use and CI with configuration inheritance:

```yaml
extends: pagebeam.config.yaml

tours:
  targets:
    ci: { url: 'http://127.0.0.1:4300' }
  accounts:
    reader:
      seed:
        command: [php, artisan, demo, active-month]
        cwd: { $env: PAGEBEAM_BACKEND_PATH }
        targets: [ci]

capture:
  skipDelays: true
  environments:
    ci:
      backend:
        kind: directory
        path: { $env: PAGEBEAM_BACKEND_PATH }
        revision: '${env:PAGEBEAM_BACKEND_REVISION}'
        start: php artisan serve --host=127.0.0.1 --port=8100
        ready: 'http://127.0.0.1:8100/'
      frontend:
        start: npm run dev -- --host 127.0.0.1 --port 4300
        ready: 'http://127.0.0.1:4300'
      fixtures: { version: 'demo-${env:PAGEBEAM_BACKEND_REVISION}' }
      disposable: true
```

Pass the overlay with `--config pagebeam.config.ci.yaml`, or the action's `capture-config` input.
`extends` accepts one JSON or YAML file or an ordered list. Later files override earlier files;
the current file overrides its parents. Objects merge recursively and arrays replace completely.
Include paths resolve beside the file declaring them. Runtime paths, including seed `cwd`, still
resolve from `--cwd`. Cycles and inheritance deeper than 32 files are rejected. Configuration files
are data and never execute modules.

Environment references resolve after merging, so a profile can replace a setting whose variable is
not needed in that profile. `${env:NAME}` inserts a required string value. `${env:NAME:-fallback}`
provides a string default. `{ $env: NAME, default: value }` references an entire value; an unset or
empty variable uses its default, retaining the default's type. Environment values themselves are
strings and are never recursively expanded. Shell expressions such as `${HOME}` remain literal
configuration data for the invoked command to handle. Quote templates inside YAML flow mappings.
Missing required variables fail before application startup, naming the variable without its value.
Use command argument arrays for values that must be passed literally rather than interpreted by a shell.

Seeds accept either an existing shell command or an argument array, with an optional working directory.
For example, a project can call its existing PHP, Python, Ruby or other fixture command directly.
The final stdout line must contain the generated account's JSON credentials. Target allowlists remain
in effect, and planning never runs the seed. No adapter script is needed to change directories or
forward arguments and credentials.

A screenshot following a saved `goto` inherits that navigation's pathname. Use `shot.route` when
an intervening interaction changes the URL. The browser checks the expected pathname before and
after taking the screenshot; inference does not turn an unexpected redirect into coverage.
A screenshot without a prior navigation or explicit route does not count as affected-screen coverage.
Page-state assertions remain part of the project's journeys.

`capture.skipDelays: true` skips numeric `wait` steps during capture, while preserving selector waits
and assertions. It defaults to false. This lets a CI profile skip fixed pacing or rate-limit pauses
when its isolated environment does not need them, without rewriting the saved journey. Guided `shoot`
recordings retain their configured timing.

Plan-only actions retain a native outcome artifact for `no-ui` and `incomplete` results. Pass that
artifact to the same reusable reporter used for captures, so skipped runs can replace an older PR
table. No application install, seed or server startup is performed. Plans that need browser capture
only expose their selection outputs and leave execution to the conditional capture job.

### Affected-screen coverage

A screenshot uses its explicit `shot.route`, or the pathname of its most recent saved `goto`. The browser checks this pathname and the target origin
before capturing; a redirect to login cannot become a successful screenshot of another screen.
Keep assertions for the page's content and the state being reviewed in the saved journey.

```yaml
tours:
  journeys:
    wallets:
      account: reader
      steps:
        - goto: /wallets
        - expect: { selector: '[data-test=wallet-list]' }
        - shot: { name: list, route: /wallets }
```

`--plan --base origin/main` returns the selected journeys, affected routes, source-file reasons,
and a coverage status: `complete`, `no-ui`, or `incomplete`. It starts no services and runs no
application commands. Missing checkpoints, unresolved source dependencies, unknown changed files,
and a capture budget exceeded all return exit code 2. New and deleted routes are reported explicitly
as incomplete because the same screen is unavailable in one revision. No substitute screen is selected.
Explicit `--all` or `--journey` runs return `manual` coverage, not an automatic coverage claim.

The default analyzer recognizes conventional Next.js, Nuxt, SvelteKit, Remix, Vue Router and pages-folder routes.
It follows static imports, literal lazy imports, re-exports, layouts and framework component names.
Computed imports, dynamic components and runtime route configuration cannot establish complete coverage.
Source analysis identifies routes, not every conditional state on them. Saved journeys define the login,
data and interactions needed for those states. Account preparation alone is not screenshot coverage.

### Automatic screen captures

Enable discovery for an application to review changes without maintaining screenshot journeys.
With a source-enabled model configured, `capture --mode auto --base ...` reads the actual diff, identifies distinct
visible changes and chooses comparable states. Changes inside menus require an expanded-menu state;
a screenshot of the default page does not cover them. Responsive default views include their initial
state at both representative widths, before optional selections or nested menus. Recognized responsive
CSS requires representative wide and narrow views; selected responsive error states include both widths to review their message
and recovery controls. Coverage is reported as model assessment.

```yaml
model:
  baseUrl: https://your-provider.example/v1
  name: your-model
  apiKeyEnv: PAGEBEAM_MODEL_KEY
  sendSource: true
capture:
  discovery:
    context: .pagebeam/fixture-context.json
    maxCalls: 40
    maxDecisions: 8
    timeoutMs: 180000
  impact:
    root: apps/editor
```

Keep targets, account login and disposable fixture setup in the capture configuration. Fixture data
and generated values must be deterministic across replays. Configure `fixtures.restore` to restore the
same complete starting data before each discovered state and each saved review replay; this prevents
action-driven data changes from contaminating later screenshots. Fixture context
is JSON describing available records, workspace memberships and permissions, without credentials or
screenshot instructions. A public frontend can use `login: { anonymous: true }`; a frontend without a
backend uses `backend: { kind: none }`. No saved journeys are required. Each application needs its own
target and impact root when multiple applications share route paths.

Automatic screenshot review chooses representative changed UI states. It does not establish every
business workflow or decide the correct business outcome. Keep explicit saved journeys and assertions
for critical functional tests. Each discovery run saves a recipe that can inform those tests after
its expected outcome has been reviewed; an exhaustive handwritten journey catalogue is unnecessary.

Pagebeam discovers Git changes, traces imports and routes, starts configured environments and observes
the running browser. The model judges which visible changes matter and how to reach them using bounded
browser actions. It cannot execute scripts, read environment credentials or issue screenshots. Provider
options can be passed through `model.parameters` and overridden for `changes`, `plan` or `navigate`
under `model.reviewParameters`; authentication remains in environment variables.
Pagebeam selects changed source excerpts and component-to-route relationships itself. Navigation also
receives successful paths already learned on the same revision. Source sharing requires
`sendSource: true`; sensitive-looking excerpts are withheld. If missing evidence concerns omitted or
shortened source, Pagebeam retrieves one focused source batch and asks for classification again.

Navigation reads the corresponding revision’s component source when the diff omits unchanged prerequisites.
Visible assertions must fit inside the screenshot frame and clipping containers. Learned actions and
assertions are frozen in a recipe. Clicks on nested labels bind to their observed controls. A failed
saved recipe can trigger one bounded rediscovery pass when disposable fixtures can be restored;
failed attempts remain in the report artifacts. Screenshot capture, baseline replay,
independent head replay and pixel comparison then run without model calls. Baseline navigation can
differ when a redesign moved a control; the recipe records both action sequences and the comparison
is explicitly model assessed. Unreachable states, missing fixture data, exhausted budgets and unstable
screenshots produce an incomplete report rather than a coverage claim. Completed states remain in
the report if later discovery fails.

Public cacheable assets are frozen in memory within each revision, including external JSON assets.
Authenticated responses, private/no-store responses, navigation documents and same-origin JSON data
are excluded. Snapshots respect response variants and have bounded memory; artifacts record resource
hashes rather than response bodies.

Browser rendering disables subpixel font positioning for repeatable text placement.
Still reviews disable transitions before navigation and wait for fonts and layout. Calibration retries
up to three times while a page settles; persistent instability remains a failure.

Screenshots include a difference image. Repeated calibration frames identify a bounded volatile-pixel
mask, which must pass a held-out frame and an independent fresh-context replay. Larger instability is
reported instead of being hidden. Recipes, decisions, stability measurements and native before/after
reports are written beneath the ignored `.pagebeam/runs/` directory. The reusable action publishes
the same native report and image table.

Without a source-enabled model, discovery uses static route tracing and optional disclosure-control exploration.
It resolves application-scoped TypeScript, Vite and Nuxt aliases, workspace exports and literal Vue
Router routes. Named imports follow their exported dependencies. In disposable environments it opens
up to `maxControls` semantic disclosure controls; this limited mode does not claim arbitrary interaction
coverage. Use `--mode saved` for explicit journeys and check-only runs.

For other frameworks and server-rendered apps, declare route dependencies with project-relative globs:

```yaml
capture:
  impact:
    root: .
    routes:
      /wallets: ['templates/wallets/**', 'controllers/wallets.*']
    ignore: ['docs/**', 'scripts/release.*']
    global: ['themes/**']
    maxJourneys: 6
```

Declared dependencies supplement discovered routes. `ignore` classifies otherwise unknown changes
as non-UI; it does not hide a dependency already traced to a route. `global` marks changes that can
affect every discovered route. Styles, public assets, application plugins and dependency manifests
are global by default when no narrower dependency is known. Unknown source files are never silently
ignored. Paths are relative to `impact.root`, which must be inside the capture checkout.
The automatic budget defaults to six journeys; exceeding it lists the affected set without capturing a subset.
Manual runs bypass that budget. Desktop remains the default, including manual full-suite runs.

Only affected screenshot checkpoints are retained in an automatic run. Other steps still run to reach
the required state. Failed-step images remain in the raw run directory for diagnosis and are excluded
from the before-and-after table. Portable outcomes carry coverage and its reasons for other renderers.
The SDK exposes `ImpactAnalyzer` and `planCaptures` so other route analyzers can supply the same contract.

### Reusable GitHub jobs

The root action builds the CLI from its pinned source when `version` is omitted. Set `version`
only when deliberately selecting a published npm release. Set up the application runtimes, isolated
backend and fixtures in the calling job. For non-UI changes, use a separate lightweight planning job
before provisioning those services. The capture job needs read-only access; application startup
and installation execute project code.

```yaml
jobs:
  capture:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      artifact-id: ${{ steps.pagebeam.outputs.artifact-id }}
    steps:
      - uses: pagebeam/pagebeam@main
        id: pagebeam
        with:
          command: capture
          environment: ci
          target: ci
          compare-base: ${{ github.event.pull_request.base.sha }}
          install: npm ci

  report:
    needs: capture
    if: always() && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: write
      actions: read
      pull-requests: write
    uses: pagebeam/pagebeam/.github/workflows/report-capture.yml@main
    with:
      artifact-id: ${{ needs.capture.outputs.artifact-id }}
      pull-request: ${{ format('{0}', github.event.pull_request.number) }}
      head-sha: ${{ github.event.pull_request.head.sha }}
      status: ${{ needs.capture.result }}
```

Pin both references to a reviewed commit or release in production workflows. The `install` command
runs in the application checkout and in the baseline snapshot. Override
`baseline-install` when the baseline needs a different command. Set `checkout: false` with an
explicit `cwd` to preserve a caller-prepared checkout and generated configuration. Use disposable test
data and never expose repository secrets or write
credentials to untrusted application code. Fork PRs can upload artifacts and summaries; their
read-only token cannot publish a PR comment. Do not use `pull_request_target` to execute PR code.

The reporting job executes no application code. It validates the artifact's run, revision and PR,
then uploads referenced PNGs to a screenshot-storage prerelease and embeds them in a Markdown
before-and-after table. The release is named `Pagebeam screenshots`, uses the `pagebeam-captures`
tag by default, and is never marked as the latest product release. Image names include the PR,
run and content hash; matching assets are reused. Stale revisions do not replace newer comments.

This publisher needs contents write access as well as PR comment permission. Keep those permissions
in the separate reporting job. Review release-triggered workflows before adopting release storage.
Artifacts pass capture data between jobs; reviewers see the image table directly in the PR.

The capture action plans before running `install`. Its optional `prepare` command runs first so it can
write configuration without installing the application. `prepare` receives `PAGEBEAM_CLI`, pointing to
the built command when using the pinned source action. Use `plan: 'true'` in a lightweight job to skip
application installation, backend provisioning and browser startup. Outputs `coverage`, `capture-needed`
and `plan` let the caller condition its more expensive job:

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      needed: ${{ steps.pagebeam.outputs.capture-needed }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: pagebeam/pagebeam@main
        id: pagebeam
        with:
          command: capture
          checkout: 'false'
          cwd: .
          plan: 'true'
          base: ${{ github.event.pull_request.base.sha }}
  capture:
    needs: plan
    if: needs.plan.outputs.needed == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: pagebeam/pagebeam@main
        with:
          command: capture
          checkout: 'false'
          cwd: .
          environment: ci
          target: ci
          compare-base: ${{ github.event.pull_request.base.sha }}
```

Planning still needs Node.js and the Pagebeam command, not application dependencies. Pin both jobs
to the same reviewed Pagebeam revision and pass the same configuration, base and selection inputs.
GitHub job services start before steps, so a service declared in the capture job is only skipped when
that entire job is conditional on a separate plan. Manual selections are also available through these inputs.
