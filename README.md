# pagebeam

Docs that keep up with your product.

pagebeam checks every page against the application it describes, tells you how
sure it is, and opens the pull request that fixes what it can. Open source, in
the repo you already have.

```
npx pagebeam check
```

## Checks

| Check | Finds | Default |
| --- | --- | --- |
| `links` | A page pointing at a route or a file that is not there | on |
| `configKeys` | A setting the documentation describes that no example config declares | on |
| `openapi` | An endpoint documented that the specification lacks, and operations nothing documents | on |
| `strings` | A control named in the documentation that the application no longer has | off |
| `moved` | Code changing under a page that did not change with it | off |
| `undocumented` | A screen of controls the documentation never mentions | on |

`strings` and `moved` are off until asked for, and compare against an earlier
revision. `undocumented` reads the application rather than its history, and is
always `review`, so it reports without ever failing a build.

## Standing

A finding says what its evidence can carry.

**proven**: the source of truth says so. A built site has no such route. A
control was in the application at a known revision and is not now.

**review**: worth a person's time, and not proof. Absence from what could be
read is not absence from the product. A label may be assembled at runtime, or
live in an application no parser covers.

Only `proven` findings can fail a build, and only under an enforcing profile.

## Usage

```
pagebeam check                     report everything, block nothing
pagebeam check --profile enforce   fail on proven findings this change introduced
pagebeam fix                       say what it would propose
pagebeam fix --publish             open or update the pull request
```

Exit `0` nothing blocks, `1` a proven finding blocks, `2` the answer cannot be
trusted: nothing was read, or a check that was asked for could not run.

## Proposals

A check can prove a page is wrong without being able to say what it should say
instead. Name a provider and each of those findings is put to it once, with the
page and the evidence already gathered.

Any endpoint answering the OpenAI chat completions shape works: a provider's
own address, a gateway in front of several, or a router on this machine.
pagebeam ships no provider code and never sees a key, only the name of the
variable holding one. Use `headers` where a provider wants more than a bearer
token, and `enrich: false` to keep the provider configured and stop asking it.

Point `skills` at whatever the project already keeps for the people who write
its documentation. pagebeam does not read them or decide what counts: they are
given to the model as they are, after the rules about how it must answer and
what it may not invent, which they cannot displace.

```yaml
model:
  skills:
    - docs/writing-style.md
    - docs/TERMS.md
```

A file named here that cannot be read stops the run. Anyone who can commit to
the repository can change what these say, which is the same trust you already
place in what CI runs.

### What leaves this machine

By default: the documentation page, the finding, and the evidence for it.

Describing a control needs more than its name, so `sendSource: true` also
sends the source the controls were found in. That is the product itself
rather than its documentation, so it is off until you say otherwise. Every
file sent is named in the run's output, and one that looks like it holds a
credential is held back and reported rather than sent.

```yaml
model:
  sendSource: false   # the default
```

### What is refused

A draft that comes back unchanged, or shorter than half the page it was given,
is refused rather than proposed. A provider that cannot answer leaves the
finding exactly as it was.

Every draft is marked as written by a model. A pull request containing one
opens as a draft, because a change worked out from the source says exactly
what it replaces and expects to find, while a drafted page is a suggestion
about prose nobody has read yet. Set `propose.draft` to decide it yourself.

## Configuration

`pagebeam.config.yaml` beside the documentation.

```yaml
docs:
  root: docs                    # where the pages are
  include: ['**/*.{md,mdx,markdown,astro}']
  buildDir: dist                # the built site, if there is one
  routeBase: /docs              # if the site serves these pages under a prefix

history:
  sinceDays: 30                 # how far back to compare

apps:                           # every application the documentation describes
  - name: dashboard
    path: ../dashboard
    include: ['**/*.{vue,ts,tsx,js}']
    envFiles: ['.env.example']
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

Every setting is checked. One that does not exist is an error, not a shrug.

## Coverage

Reading files sees every control an application declares. Opening a running
application sees what a user sees, including labels assembled at runtime and
resolved from a catalogue, and only on the pages it is told to open.

Neither alone is enough, so it does both where it can, and a finding says which
it rested on. Rendering can prove a control exists; it can never prove one is
gone, because a page nobody opened shows nothing.

Parsers: Vue, React, Svelte, Astro, HTML and server-side templates, each
through that framework's own compiler. Anything else is searched as text and
says so.

## Releasing

Published from GitHub Actions without a token. npm is told to trust
`.github/workflows/publish.yml` in this repository, and checks the identity
GitHub issues for the run, so there is no long-lived credential to leak or
rotate. Each package carries provenance saying which commit and which workflow
built it.

Tag the version and push the tag. The workflow refuses to publish if any
package disagrees with the tag.

```
git tag v0.1.1 && git push origin v0.1.1
```
