# dev-servers

A Claude Code mod that puts two start/stop buttons in a band above the prompt,
for getting a Rojo project running:

- **Rojo serve**: `rojo serve` (shows the port once Rojo is listening)
- **Watch tree**: `node tools/watchTree.js`

The band only appears in folders that have a `default.project.json`. Each
button shows a status dot (green running, red exited with its code), and a
**Logs** button shows the last few lines from each. Both stop when the session
ends.

`rojo` and `node` must be on the PATH Claude Code sees. On macOS, if the Rojo
button shows "Could not start", the app probably can't see `~/.rokit/bin`.

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
