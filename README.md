# dev-servers

A Claude Code mod for Roblox game repos. It puts sync controls in a band above
the prompt and adds a `/new-game` command.

## Crunch Sync (repos with a `sync/` folder)

When the session's folder is a game repo with Crunch Sync (`sync/crunch-sync.ps1`
or `sync/Crunch Sync.command`, from the game template), the band shows one
**Crunch Sync** button. It starts the repo's Crunch Sync script (no
double-clicking) together with `node tools/watchTree.js`, and Crunch starts Rojo
for every place straight away: each `*.project.json` at the top of the repo,
leaving out `default.project.json` when named places (`Lobby`, `Game`) sit
beside it, since it's only there for tooling. The band then shows the game, each
place with its port, and a **Sync page** link. Project files that appear later
(say `genRojoTree.js` writing a new place) are picked up without restarting
Claude Code. Press it again to stop everything,
Rojo included. You can still stop or start single places from the game's Sync
tab in Crunch.

If the repo isn't linked to a game in Crunch yet, the band shows **Add to
Crunch**, which opens Crunch's new-game form with the repo, branch and port
filled in. If your Crunch config isn't saved on this computer, it points you at
Crunch's Setup page.

## Setting up a fresh clone

When the folder is a game repo that isn't set up yet (a fresh clone has no
`Packages/`, or there's no project file yet), the band shows **Set up and
sync** instead. One press runs what the repo has of:

1. `rokit install --no-trust-check` (the tools in `rokit.toml`),
2. `wally install`,
3. `node tools/postinstall.js`,
4. `node tools/genRojoTree.js`,

then starts Crunch Sync. Each step ticks off on the band, and **Logs** shows the
output. If Rokit isn't installed, it links to Rokit's install page. Rokit's
tools are run from `~/.rokit/bin`, so a fresh Rokit install works without
restarting Claude Code.

## Rojo serve (repos without Crunch Sync)

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
last few lines. Everything stops when the session ends. On the mobile app the
picker is a button that cycles.

## New game

`/new-game` opens a window: type the name, check the folder, template and
GitHub owner (remembered after the first time), and press **Create game**. It

1. runs the template's `tools/newProject.js` (copy, rename, install, check, commit),
2. gives the game the next free Rojo port after the other games in that folder,
3. makes a private GitHub repo with `gh repo create --private --push`
   (leave the owner blank to skip; needs the GitHub CLI and `gh auth login`),
4. shows **Add it to Crunch**, which opens Crunch's new-game form filled in.

Then open the new folder in Claude Code and press **Crunch Sync**.

`rojo` and `node` must be on the PATH Claude Code sees. On macOS, if Rojo shows
"Could not start", the app probably can't see `~/.rokit/bin`. Crunch's address
comes from `~/.crunch/config.json` (Crunch's Setup page writes it); the mod never
reads or shows the token.

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
