# pagebeam

Docs that keep up with your product.

pagebeam checks each page of your docs against the product it describes. It
says how sure it is, and opens a pull request with the fixes it can make. It
is open source and runs in the repository you already have.

Full documentation: https://docs.pagebeam.dev

## Application evidence

`pagebeam capture` runs selected application journeys, checks visible outcomes,
and writes screenshots, a run report, and a browsable gallery. Another tool can
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

Changed-file selection uses declared paths and representative groups. Unmapped
changes never trigger a full run. `--all` explicitly selects the full suite.

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

The output directory has an `index.html` gallery with paired images, revision labels, and links to
both capture reports. Failed comparisons remain labelled as incomplete and block the capture job.
An unmapped change is labelled as uncovered. The JSON output includes the gallery path.

### Reusable GitHub jobs

The root action builds the CLI from its pinned source when `version` is omitted. Set `version`
only when deliberately selecting a published npm release. Set up the application runtimes, isolated
backend and fixtures in the calling job. The capture job needs read-only access; application startup
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
      contents: read
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

The reporting job executes no application code. It checks that the artifact belongs to the expected
workflow run, revision and PR, skips stale revisions, and updates one gallery comment. GitHub
artifacts are downloads, so reviewers extract the archive and open `index.html`; inline PR images
require separate hosting.
