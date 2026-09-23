# Changelog

## 0.1.3

### A GitHub Action

`uses: pagebeam/pagebeam@v1` runs `check` or `fix` in CI. It checks out the
documentation and every product repository it names at `<owner>/<name>`, so a
config that says `path: ../dashboard` works in CI as it does on a laptop.

### Routes read by each framework's rules

- Next.js (App and Pages Router), SvelteKit, Remix, Nuxt and Astro routes are
  read by their own rules, including layouts, parent routes and optional
  segments.
- The Next.js config is parsed, not searched. `pageExtensions` and `basePath`
  come from the exported object only, so a value in a comment changes nothing.
  A config built by code makes the list of screens incomplete, and the run
  says so.
- In a repository with several applications, each follows its own Next.js
  config.
- Next.js pages written in `.js` or `.ts` are found through the dependency on
  `next`, and JSX in `.js` files is read.
- Pages in an extension the config adds, such as MDX, are read. A page no
  parser can read is named in the output.
- The home screen is matched to the home page.

### API coverage

- An operation counts as documented only where a reader sees its method with
  its path. A method belongs to the path right after it.
- Hidden HTML is not documentation, in the source or the built site.
- An operation named only in a component's attributes counts once the built
  site shows it.
- Citations carry their real line numbers.
- A built site too large to read in full is reported, not counted.

### Proposals

- The documentation is checked once every change is in place. A proposal that
  keeps a broken link, adds a dead external link or leaves a new finding is not
  published.
- Several drafts for one page no longer undo each other.
- `fix` says what it sent to the model and what it held back.

### Other fixes

- History that cannot be read makes the run fail (exit code 2) instead of
  reading as a repository with no history.
- `init` quotes folder names that YAML would read as something else, such as
  `true`.

## 0.1.2

The first release that installs and runs. See the
[release notes](https://github.com/pagebeam/pagebeam/releases/tag/v0.1.2).

## 0.1.1

Shipped the compiler's output instead of the bundle and could not start.
Deprecated.

## 0.1.0

First release.
