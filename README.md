# pagebeam

Docs that keep up with your product.

pagebeam checks every page against the application it describes, tells you how
sure it is, and opens the pull request that fixes what it can. Open source, in
the repo you already have.

```
npx pagebeam check
```

## Checks

| Check | Finds |
| --- | --- |
| `links` | A page pointing at a route or a file that is not there |
| `config-keys` | A setting the documentation describes that no example config declares |
| `openapi` | An endpoint documented that the specification lacks, and operations nothing documents |
| `strings` | A control named in the documentation that the application no longer has |
| `moved` | Code changing under a page that did not change with it |

## Limitations

pagebeam will not tell you whether a sentence is true. Every finding traces to
something checkable: a route that does not resolve, a label no longer declared,
a key absent from every example. Nothing here reads prose and judges it.

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

propose:
  branch: pagebeam/drift
  base: main
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
