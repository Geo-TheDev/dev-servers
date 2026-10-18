# dev-servers

A Claude Code mod that puts start/stop controls for a Rojo project in a band
above the prompt:

- **Rojo**: `rojo serve` for any `*.project.json` in the folder. With more than
  one project a picker chooses which place the Serve/Stop button acts on. Every
  place serves on Rojo's default port (34872), so Studio's plugin never needs
  changing; serving one place stops the other first. `default.project.json` is
  left out when named places (`Game`, `Lobby`) sit beside it, since it's only
  there for tooling.
- **Watch tree**: `node tools/watchTree.js`, shown only when the repo has that
  script. One watcher regenerates every project file.

The band only appears in folders that have a project file. Each control shows
a status dot (green running, red exited with its code), and **Logs** shows the
last few lines of the selected Rojo place and the watcher. Everything stops
when the session ends. On the mobile app the picker is a button that cycles.

`rojo` and `node` must be on the PATH Claude Code sees. On macOS, if Rojo shows
"Could not start", the app probably can't see `~/.rokit/bin`.

## Install

This repository is private: installing needs read access to it on GitHub and a
git credential for github.com on the machine (an SSH key, or `gh auth login`
then `gh auth setup-git`).

At the prompt of a terminal session:

```
/plugin install dev-servers --marketplace Geo-TheDev/dev-servers
```

From a shell:

```bash
claude plugin install dev-servers --marketplace Geo-TheDev/dev-servers
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `Geo-TheDev/dev-servers`, then Add
plugin.

## Developing

```bash
claude plugin validate .
claude plugin test .
```
