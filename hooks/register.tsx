import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { NewGameForm, NewGameRun, NewGameStep, ServerId, ServerState, SyncPlace, SyncState } from '../types'

type Server = { id: ServerId; label: string; argv: string[] }

// A rojo serve for any *.project.json in the session root. Every place uses
// Rojo's default port, so Studio's plugin never needs changing; serving one
// place stops the other first, as only one can hold the port.
type Project = { file: string; name: string; port: number }

type Setup = { projects: Project[]; watcher?: Server }

const PROJECT_SUFFIX = '.project.json'
const DEFAULT_PROJECT = 'default.project.json'
const PORT_NUMBER = 34872
const WATCH_SCRIPT = 'tools/watchTree.js'
const WATCHER: Server = { id: 'watch', label: 'Watch tree', argv: ['node', WATCH_SCRIPT] }

const MAX_LINES = 40
const LOG_LINES_SHOWN = 6
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const PORT = /Port:\s*(\d+)/i

const STOPPED: ServerState = { status: 'stopped', lines: [] }

const servers = atom({ plugin: 'dev-servers', key: 'servers' } as const, {} as Record<ServerId, ServerState>)
const selected = atom({ plugin: 'dev-servers', key: 'selected' } as const, {} as Record<string, string>)
const isShowingLogs = atom({ plugin: 'dev-servers', key: 'isShowingLogs' } as const, false)
const syncs = atom({ plugin: 'dev-servers', key: 'sync' } as const, {} as Record<string, SyncState>)
const newGameForm = atom({ plugin: 'dev-servers', key: 'newGameForm' } as const, {
  name: '',
  folder: '',
  template: '',
  owner: '',
  strip: false,
} as NewGameForm)
const newGameRun = atom({ plugin: 'dev-servers', key: 'newGameRun' } as const, { status: 'idle', steps: [], lines: [] } as NewGameRun)

const running: Record<ServerId, HookStream<ProcessSpawnChunk, ProcessSpawnResult>> = {}
const setups = new Map<string, Setup>()

const discover = async ($: EngineInterface, root: string): Promise<Setup> => {
  const known = setups.get(root)
  if (known) return known

  const entries = await $.fs.list(root).catch(() => [])
  const all = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith(PROJECT_SUFFIX))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))

  // Beside named places (Game, Lobby), default.project.json is only there for
  // tooling (the sourcemap), not for serving, so it's left out.
  const named = all.filter(file => file !== DEFAULT_PROJECT)
  const files = named.length > 0 ? named : all

  const setup: Setup = {
    projects: files.map(file => ({ file, name: file.slice(0, -PROJECT_SUFFIX.length), port: PORT_NUMBER })),
    watcher: (await $.fs.exists(`${root}/${WATCH_SCRIPT}`)) ? WATCHER : undefined,
  }
  setups.set(root, setup)
  return setup
}

const rojoOf = (project: Project): Server => ({
  id: `rojo:${project.file}`,
  label: project.name,
  argv: ['rojo', 'serve', project.file, '--port', String(project.port)],
})

const stateOf = (all: Record<ServerId, ServerState>, id: ServerId) => all[id] ?? STOPPED

const patch = ($: EngineInterface, id: ServerId, fn: (state: ServerState) => ServerState) =>
  update($, servers, all => ({ ...all, [id]: fn(stateOf(all, id)) }))

const addOutput = ($: EngineInterface, id: ServerId, text: string) => {
  const found = text.replace(ANSI, '').replace(/\r/g, '').split('\n').map(line => line.trimEnd()).filter(line => line !== '')
  if (found.length === 0) return

  return patch($, id, state => {
    const port = found.map(line => PORT.exec(line)?.[1]).find(match => match !== undefined)
    return {
      ...state,
      lines: [...state.lines, ...found].slice(-MAX_LINES),
      port: port !== undefined ? Number(port) : state.port,
    }
  })
}

const start = async ($: EngineInterface, server: Server) => {
  if (running[server.id]) return

  await patch($, server.id, () => ({ status: 'running', lines: [] }))
  let result: ProcessSpawnResult | undefined
  try {
    const stream = $.process.spawn({ argv: server.argv, cwd: await $.session.root() })
    running[server.id] = stream
    while (true) {
      const step = await stream.next()
      if (step.done) {
        result = step.value
        break
      }

      await addOutput($, server.id, step.value.text)
    }
  } catch (error) {
    await addOutput($, server.id, `Could not start: ${String(error)}`)
  } finally {
    delete running[server.id]
    await patch($, server.id, state => {
      const wasStopped = state.status === 'stopping'
      const isClean = wasStopped || result?.code === 0
      return {
        ...state,
        status: isClean ? 'stopped' : 'failed',
        port: undefined,
        note: wasStopped ? undefined : `exited ${result?.code ?? '?'}`,
      }
    })
  }
}

const stop = async ($: EngineInterface, id: ServerId) => {
  const stream = running[id]
  if (!stream) return

  await patch($, id, state => ({ ...state, status: 'stopping' }))
  await stream.return({ code: null, signal: 'stopped' })
}

const toggle = ($: EngineInterface, server: Server) =>
  running[server.id] ? stop($, server.id) : start($, server)

const isRojo = (id: ServerId) => id.startsWith('rojo:')

const serve = async ($: EngineInterface, server: Server) => {
  if (running[server.id]) return stop($, server.id)

  await Promise.all(Object.keys(running).filter(id => isRojo(id) && id !== server.id).map(id => stop($, id)))
  return start($, server)
}

const isUp = (state: ServerState) => state.status === 'running' || state.status === 'stopping'

const dotOf = (state: ServerState) =>
  state.status === 'running' ? '●'
  : state.status === 'stopping' ? '◐'
  : state.status === 'failed' ? '✕'
  : '○'

const colourOf = (state: ServerState) =>
  state.status === 'running' ? 'success'
  : state.status === 'failed' ? 'error'
  : 'subtle'

const portOf = (state: ServerState, planned?: number) =>
  state.port !== undefined ? `:${state.port}` : planned !== undefined ? `:${planned}` : ''

const detailOf = (state: ServerState, planned?: number) =>
  state.status === 'running' && state.port !== undefined ? `:${state.port}`
  : state.status === 'running' ? 'starting'
  : state.status === 'stopping' ? 'stopping'
  : state.status === 'failed' ? (state.note ?? 'failed')
  : planned !== undefined ? `:${planned}`
  : 'start'

const actionOf = (state: ServerState) =>
  state.status === 'running' ? 'Stop'
  : state.status === 'stopping' ? 'Stopping'
  : state.status === 'failed' ? 'Retry'
  : 'Serve'

// ---------- Host facts ----------

type Host = { platform: string; home: string; sep: string }

let hostInfo: Host | undefined

// The machine's platform and home folder, from node (which the watcher needs anyway).
const host = async ($: EngineInterface): Promise<Host> => {
  if (hostInfo) return hostInfo
  try {
    const { stdout } = await $.process.run([
      'node',
      '-p',
      'JSON.stringify({ platform: process.platform, home: require("os").homedir(), sep: require("path").sep })',
    ])
    hostInfo = JSON.parse(stdout.trim()) as Host
  } catch {
    hostInfo = { platform: 'unknown', home: '', sep: '/' }
  }
  return hostInfo
}

const join = (h: Host, ...parts: string[]) => parts.filter(part => part !== '').join(h.sep).replace(/[\\/]+$/, '')

const parentOf = (path: string) => path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')

// Crunch's address from ~/.crunch/config.json (Crunch's Setup page writes it). The token is never read here.
const crunchUrl = async ($: EngineInterface): Promise<string | undefined> => {
  const h = await host($)
  if (!h.home) return undefined
  try {
    const config = JSON.parse(await $.fs.read(join(h, h.home, '.crunch', 'config.json'))) as { url?: unknown }
    return typeof config.url === 'string' && /^https?:\/\//.test(config.url) ? config.url.trim().replace(/\/+$/, '') : undefined
  } catch {
    return undefined
  }
}

// Git refuses a repo whose folder another user owns ("dubious ownership": a second drive, a copied folder).
// These reads trust just this folder for the one call; the person's git settings aren't changed.
const gitIn = async ($: EngineInterface, cwd: string, args: string[]) => {
  try {
    const { exitCode, stdout } = await $.process.run(['git', '-c', `safe.directory=${cwd.replace(/\\/g, '/')}`, ...args], { cwd })
    return exitCode === 0 ? stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

const readText = async ($: EngineInterface, path: string) => {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

// origin's URL from .git/config, for when git itself won't answer.
const originFromConfig = async ($: EngineInterface, cwd: string) => {
  const lines = (await readText($, `${cwd}/.git/config`))?.split(/\r?\n/) ?? []
  let isOrigin = false
  for (const line of lines) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line)
    if (section) {
      isOrigin = /^remote\s+"origin"$/.test(section[1] ?? '')
      continue
    }
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)
    if (isOrigin && url) return url[1]
  }
  return undefined
}

// owner/name of a folder's GitHub origin remote.
const githubRepoOf = async ($: EngineInterface, cwd: string): Promise<string | undefined> => {
  const url = (await gitIn($, cwd, ['remote', 'get-url', 'origin'])) ?? (await originFromConfig($, cwd))
  return url ? /github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url)?.[1] : undefined
}

const currentBranch = async ($: EngineInterface, cwd: string) =>
  (await gitIn($, cwd, ['branch', '--show-current'])) ??
  /^ref:\s*refs\/heads\/(.+)$/m.exec((await readText($, `${cwd}/.git/HEAD`)) ?? '')?.[1]?.trim()

const servePortOf = async ($: EngineInterface, file: string): Promise<number | undefined> => {
  try {
    const port = (JSON.parse(await $.fs.read(file)) as { servePort?: unknown }).servePort
    return typeof port === 'number' && Number.isInteger(port) ? port : undefined
  } catch {
    return undefined
  }
}

// Crunch's new-game form, filled in; Crunch jumps to the game instead when the repo is already linked.
const addToCrunchLink = (url: string, game: { name?: string; repo?: string; branch?: string; port?: number }) => {
  const query = [
    'new=1',
    ...Object.entries(game)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`),
  ]
  return `${url}/games?${query.join('&')}`
}

const cleanLines = (text: string) =>
  text.replace(ANSI, '').replace(/\r/g, '').split('\n').map(line => line.trimEnd()).filter(line => line !== '')

// ---------- Crunch Sync ----------

// The repo's Crunch Sync script (the sync/ folder from the game template), or nothing.
const SYNC_PS1 = 'sync/crunch-sync.ps1'
const SYNC_SH = 'sync/Crunch Sync.command'
const PID_LINE = /^\[crunch-sync-pid\] (\d+)$/
const STAMP = /^\[\d\d:\d\d\] /

const hasSync = async ($: EngineInterface, root: string) =>
  (await $.fs.exists(`${root}/${SYNC_PS1}`)) || (await $.fs.exists(`${root}/${SYNC_SH}`))

const SYNC_STOPPED: SyncState = { status: 'stopped', lines: [], places: {} }

const syncRunning: Record<string, HookStream<ProcessSpawnChunk, ProcessSpawnResult>> = {}
const syncPids: Record<string, number> = {}

const syncOf = (all: Record<string, SyncState>, root: string) => all[root] ?? SYNC_STOPPED

const patchSync = ($: EngineInterface, root: string, fn: (state: SyncState) => SyncState) =>
  update($, syncs, all => ({ ...all, [root]: fn(syncOf(all, root)) }))

// Reads what the script prints (the same lines the double-clicked window shows) into the band's state.
const readSyncLine = (state: SyncState, raw: string): SyncState => {
  const line = raw.replace(STAMP, '').trim()
  const place = (name: string, port: number, placeState: SyncPlace['state']) => ({
    ...state.places,
    [name]: { port, state: placeState },
  })
  const known = (name: string) => state.places[name]?.port ?? 0

  let match: RegExpExecArray | null
  if (/^No Crunch game is linked/.test(line)) state = { ...state, isUnlinked: true }
  if (/^Your Crunch config isn't saved/.test(line)) state = { ...state, needsConfig: true }
  if (state.problem) return { ...state, problem: [...state.problem, line] }
  if (line === "Crunch Sync can't start") return { ...state, problem: [] }
  if (/^Connected\./.test(line)) return { ...state, status: state.status === 'stopping' ? state.status : 'connected' }
  if ((match = /^Game\s+(.+)$/.exec(line))) return { ...state, game: (match[1] ?? '') }
  if ((match = /^(https?:\/\/\S+\/games\/\S+\/sync)$/.exec(line))) return { ...state, page: (match[1] ?? '') }
  if ((match = /^Starting (.+) on port (\d+)\.\.\.$/.exec(line))) return { ...state, places: place((match[1] ?? ''), Number((match[2] ?? '')), 'starting') }
  if ((match = /^(.+) syncing on port (\d+)/.exec(line))) return { ...state, places: place((match[1] ?? ''), Number((match[2] ?? '')), 'syncing') }
  if ((match = /^Stopped (.+)\.$/.exec(line))) return { ...state, places: place((match[1] ?? ''), known((match[1] ?? '')), 'stopped') }
  if ((match = /^(.+) stopped unexpectedly/.exec(line))) return { ...state, places: place((match[1] ?? ''), known((match[1] ?? '')), 'starting') }
  if ((match = /^(.+) couldn't (?:sync|start):/.exec(line))) return { ...state, places: place((match[1] ?? ''), known((match[1] ?? '')), 'error') }
  return state
}

const addSyncOutput = ($: EngineInterface, root: string, text: string) => {
  const found = cleanLines(text)
  if (found.length === 0) return

  return patchSync($, root, state => {
    let next = state
    const shown: string[] = []
    for (const line of found) {
      const pid = PID_LINE.exec(line.trim())
      if (pid) {
        syncPids[root] = Number(pid[1])
        continue
      }
      next = readSyncLine(next, line)
      shown.push(line)
    }
    return { ...next, lines: [...next.lines, ...shown].slice(-MAX_LINES) }
  })
}

// The script's own process id comes first, so Stop can end it (and the Rojo servers it started) cleanly.
const syncArgv = (h: Host, root: string): string[] => {
  if (h.platform === 'win32') {
    const script = `${root.replace(/[\\/]+$/, '')}\\sync\\crunch-sync.ps1`.replace(/'/g, "''")
    return [
      'powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Write-Output "[crunch-sync-pid] $PID"; & '${script}'`,
    ]
  }
  return ['bash', '-c', 'echo "[crunch-sync-pid] $$"; exec bash "$0"', `${root}/${SYNC_SH}`]
}

// One button: Crunch Sync and, when the repo has it, the tree watcher, started and stopped together.
const startSync = async ($: EngineInterface, root: string, watcher?: Server) => {
  if (syncRunning[root]) return
  if (watcher) void start($, watcher)

  // Crunch Sync runs Rojo itself; a Rojo serve from this band would hold the same port.
  await Promise.all(Object.keys(running).filter(isRojo).map(id => stop($, id)))
  await patchSync($, root, () => ({ status: 'starting', lines: [], places: {} }))
  const h = await host($)
  let result: ProcessSpawnResult | undefined
  try {
    const stream = $.process.spawn({ argv: syncArgv(h, root), cwd: root, env: { CRUNCH_SYNC_AUTOSTART: '1' } })
    syncRunning[root] = stream
    while (true) {
      const step = await stream.next()
      if (step.done) {
        result = step.value
        break
      }
      await addSyncOutput($, root, step.value.text)
    }
  } catch (error) {
    await addSyncOutput($, root, `Could not start Crunch Sync: ${String(error)}`)
  } finally {
    delete syncRunning[root]
    delete syncPids[root]
    await patchSync($, root, state => {
      const wasStopped = state.status === 'stopping'
      return {
        ...state,
        status: wasStopped || result?.code === 0 ? 'stopped' : 'failed',
        places: {},
      }
    })
  }
}

const stopSync = async ($: EngineInterface, root: string) => {
  if (running[WATCHER.id]) void stop($, WATCHER.id)
  const stream = syncRunning[root]
  if (!stream) return

  await patchSync($, root, state => ({ ...state, status: 'stopping' }))
  const pid = syncPids[root]
  if (pid !== undefined) {
    const h = await host($)
    // Windows: end the whole tree, Rojo included. Elsewhere the script's own trap stops Rojo and says goodbye.
    const argv = h.platform === 'win32' ? ['taskkill', '/PID', String(pid), '/T', '/F'] : ['kill', '-TERM', String(pid)]
    await $.process.run(argv).catch(() => undefined)
    for (let waited = 0; waited < 50 && syncRunning[root]; waited += 1) await $.clock.sleep(100)
  }
  if (syncRunning[root]) await stream.return({ code: null, signal: 'stopped' })
}

const syncDot = (state: SyncState) =>
  state.status === 'connected' ? '●'
  : state.status === 'starting' || state.status === 'stopping' ? '◐'
  : state.status === 'failed' ? '✕'
  : '○'

const syncColour = (state: SyncState) =>
  state.status === 'connected' ? 'success'
  : state.status === 'failed' ? 'error'
  : 'subtle'

const syncLabel = (state: SyncState) =>
  state.status === 'connected' ? 'Stop sync'
  : state.status === 'starting' ? 'Starting'
  : state.status === 'stopping' ? 'Stopping'
  : state.status === 'failed' ? 'Retry sync'
  : 'Crunch Sync'

const placeDot = (place: SyncPlace) =>
  place.state === 'syncing' ? '●' : place.state === 'starting' ? '◐' : place.state === 'error' ? '✕' : '○'

const placeColour = (place: SyncPlace) =>
  place.state === 'syncing' ? 'success' : place.state === 'error' ? 'error' : 'subtle'

// ---------- New game ----------

const NEW_GAME_PANE = 'new-game'
const NEW_PROJECT_SCRIPT = 'tools/newProject.js'
const FIRST_PORT = 34873
const STORE_KEYS = ['folder', 'template', 'owner'] as const

// The template's own naming, so the folder and repo match what newProject.js makes.
const toFileName = (name: string) =>
  name
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-')

const toFolderName = (name: string) => toFileName(name).split('-').join('')

// The next port after every servePort in the folder's games, so a new game never clashes.
const pickPort = async ($: EngineInterface, h: Host, folder: string) => {
  const ports: number[] = []
  const dirs = (await $.fs.list(folder).catch(() => [])).filter(entry => entry.kind === 'dir').slice(0, 300)
  for (const dir of dirs) {
    const files = await $.fs.list(join(h, folder, dir.name)).catch(() => [])
    for (const file of files) {
      if (file.kind !== 'file' || !file.name.endsWith(PROJECT_SUFFIX)) continue
      const port = await servePortOf($, join(h, folder, dir.name, file.name))
      if (port !== undefined) ports.push(port)
    }
  }
  return Math.max(FIRST_PORT - 1, ...ports) + 1
}

// Fills the form's blanks: what was used last time, else the session's folder when it is the template.
const fillNewGameDefaults = async ($: EngineInterface) => {
  const form = await read($, newGameForm)
  const stored: Partial<NewGameForm> = {}
  for (const key of STORE_KEYS) {
    const value = await $.store.get(key)
    if (typeof value === 'string' && value !== '') stored[key] = value
  }

  const root = await $.session.root()
  const template =
    form.template || stored.template || ((await $.fs.exists(`${root}/${NEW_PROJECT_SCRIPT}`)) ? root : '')
  const folder = form.folder || stored.folder || (template ? parentOf(template) : '')
  const owner = form.owner || stored.owner || (template ? ((await githubRepoOf($, template))?.split('/')[0] ?? '') : '')

  await update($, newGameForm, current => ({ ...current, template, folder, owner }))
}

const patchRun = ($: EngineInterface, fn: (run: NewGameRun) => NewGameRun) => update($, newGameRun, fn)

const setStep = ($: EngineInterface, label: string, state: NewGameStep['state'], note?: string) =>
  patchRun($, run => {
    const steps = run.steps.some(step => step.label === label)
      ? run.steps.map(step => (step.label === label ? { label, state, note } : step))
      : [...run.steps, { label, state, note }]
    return { ...run, steps }
  })

const addRunOutput = ($: EngineInterface, text: string) => {
  const found = cleanLines(text)
  if (found.length === 0) return
  return patchRun($, run => ({ ...run, lines: [...run.lines, ...found].slice(-MAX_LINES) }))
}

const runLogged = async ($: EngineInterface, argv: string[], cwd: string) => {
  try {
    const result = await $.process.run(argv, { cwd, timeoutMs: 180_000 })
    await addRunOutput($, `${result.stdout}\n${result.stderr}`)
    return result
  } catch (error) {
    await addRunOutput($, `${argv[0]}: ${String(error)}`)
    return undefined
  }
}

let isCreating = false

const createGame = async ($: EngineInterface) => {
  if (isCreating) return
  isCreating = true
  try {
    await createGameSteps($)
  } finally {
    isCreating = false
  }
}

const fail = ($: EngineInterface, error: string) => patchRun($, run => ({ ...run, status: 'failed', error }))

const createGameSteps = async ($: EngineInterface) => {
  const form = await read($, newGameForm)
  const h = await host($)
  const name = form.name.trim()
  const template = form.template.trim().replace(/[\\/]+$/, '')
  const folder = form.folder.trim().replace(/[\\/]+$/, '')
  const owner = form.owner.trim()
  const fileName = toFileName(name)

  await patchRun($, () => ({ status: 'running', steps: [], lines: [] }))
  if (!fileName) return fail($, 'Give the game a name first.')
  if (!template || !(await $.fs.exists(`${template}/${NEW_PROJECT_SCRIPT}`)))
    return fail($, `The template folder needs ${NEW_PROJECT_SCRIPT}. Point it at your Example-Project folder.`)
  if (!folder || !(await $.fs.exists(folder))) return fail($, "The folder for new games doesn't exist.")

  const dest = join(h, folder, toFolderName(name))
  if (await $.fs.exists(dest)) return fail($, `${dest} already exists. Pick another name.`)
  for (const key of STORE_KEYS) await $.store.set(key, key === 'folder' ? folder : key === 'template' ? template : owner)

  // 1. Copy the template (and install, check and commit, as newProject.js always does).
  await setStep($, 'Make the project', 'running')
  await patchRun($, run => ({ ...run, dest }))
  const argv = ['node', NEW_PROJECT_SCRIPT, '--name', name, '--dest', dest, '--yes', '--no-color', '--ascii', form.strip ? '--strip' : '--no-strip']
  const made = await runLogged($, argv, template)
  if (!(await $.fs.exists(`${dest}/.git`))) {
    await setStep($, 'Make the project', 'failed', made ? `exited ${made.exitCode}` : 'node not found')
    return fail($, 'newProject.js did not finish. The log says why.')
  }
  await setStep($, 'Make the project', made?.exitCode === 0 ? 'done' : 'warn', made?.exitCode === 0 ? dest : 'made, but the install or check had problems (see log)')

  // 2. Its own Rojo port, so it can sync next to other games.
  await setStep($, 'Pick a port', 'running')
  const port = await pickPort($, h, folder)
  const projectFile = join(h, dest, 'default.project.json')
  try {
    const project = JSON.parse(await $.fs.read(projectFile)) as Record<string, unknown>
    await $.fs.write(projectFile, `${JSON.stringify({ ...project, servePort: port }, null, 2)}\n`)
    await runLogged($, ['git', 'commit', '-qam', `chore: serve on port ${port}`], dest)
    await setStep($, 'Pick a port', 'done', String(port))
    await patchRun($, run => ({ ...run, port }))
  } catch {
    await setStep($, 'Pick a port', 'warn', 'no default.project.json to set it in')
  }
  const branch = await currentBranch($, dest)
  await patchRun($, run => ({ ...run, branch }))

  // 3. The private GitHub repo, with the GitHub CLI.
  const repo = owner ? `${owner}/${fileName}` : undefined
  if (!repo) {
    await setStep($, 'Make the GitHub repo', 'skipped', 'no GitHub owner set')
  } else {
    await setStep($, 'Make the GitHub repo', 'running', repo)
    const made = await runLogged($, ['gh', 'repo', 'create', repo, '--private', '--source', dest, '--remote', 'origin', '--push'], dest)
    if (made?.exitCode === 0) {
      await setStep($, 'Make the GitHub repo', 'done', repo)
      await patchRun($, run => ({ ...run, repo }))
    } else {
      const why = made ? 'see the log (is `gh auth login` done?)' : 'GitHub CLI (gh) not found'
      await setStep($, 'Make the GitHub repo', 'failed', why)
    }
  }

  // 4. A link to Crunch's new-game form, filled in.
  const url = await crunchUrl($)
  const run = await read($, newGameRun)
  if (url) {
    await patchRun($, current => ({
      ...current,
      crunchLink: addToCrunchLink(url, { name, repo: run.repo, branch, port }),
    }))
  }
  await setStep(
    $,
    'Add it to Crunch',
    url ? 'done' : 'skipped',
    url ? 'press the link below' : "save your Crunch config from Crunch's Setup page first",
  )
  await patchRun($, current => ({ ...current, status: 'done' }))
}

const stepMark = (step: NewGameStep) =>
  step.state === 'done' ? '✓' : step.state === 'running' ? '◐' : step.state === 'failed' ? '✕' : step.state === 'warn' ? '!' : '–'

const stepColour = (step: NewGameStep) =>
  step.state === 'done' ? 'success' : step.state === 'failed' ? 'error' : step.state === 'warn' ? 'warning' : 'subtle'

const openNewGame = async ($: EngineInterface) => {
  await fillNewGameDefaults($)
  await $.ui.open({ id: NEW_GAME_PANE, title: 'New game', focus: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'new-game',
      description: 'Make a new game from your template: project folder, private GitHub repo and a link to add it to Crunch',
    })
    return next(e)
  })

  on('command.run', { command: 'new-game' }, async $ => {
    await openNewGame($)
    return { text: 'New game window opened.' }
  })

  // Stop Crunch Sync (and its Rojo servers) properly when the session ends.
  on('session.end', async ($, e, next) => {
    await Promise.all(Object.keys(syncRunning).map(root => stopSync($, root))).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: NEW_GAME_PANE }, async ($, e) => {
    const { Box, Button, Text, Input, Link } = $.ui.resolve(e)
    const form = await read($, newGameForm)
    const run = await read($, newGameRun)
    const isRunning = run.status === 'running'
    const set = (key: 'name' | 'folder' | 'template' | 'owner') => (value: string) =>
      void update($, newGameForm, current => ({ ...current, [key]: value }))
    const fileName = toFileName(form.name)
    const showLogs = await read($, isShowingLogs)

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>Copies your template, makes a private GitHub repo and gives you a link to add the game to Crunch.</Text>
        <Box flexDirection="column">
          <Input key="name" label="Name" placeholder="e.g. Tycoon Simulator" value={form.name} autoFocus onInput={set('name')} onSubmit={() => void createGame($)} submitLabel="create" />
          <Input key="folder" label="Make it in" placeholder="the folder your games live in" value={form.folder} onInput={set('folder')} onSubmit={() => void createGame($)} />
          <Input key="template" label="Template" placeholder="your Example-Project folder" value={form.template} onInput={set('template')} onSubmit={() => void createGame($)} />
          <Input key="owner" label="GitHub owner" placeholder="blank to skip the GitHub repo" value={form.owner} onInput={set('owner')} onSubmit={() => void createGame($)} />
          <Button key="strip" plain onPress={() => void update($, newGameForm, current => ({ ...current, strip: !current.strip }))}>
            Example content: {form.strip ? 'remove' : 'keep'} <Text dimColor>(change)</Text>
          </Button>
        </Box>
        {fileName !== '' && (
          <Text dimColor wrap="truncate-end">
            Folder {toFolderName(form.name)}{form.owner.trim() ? `, repo ${form.owner.trim()}/${fileName} (private)` : ''}
          </Text>
        )}
        <Box flexDirection="row" gap={1}>
          <Button key="create" variant="primary" label={isRunning ? 'Creating…' : 'Create game'} onPress={() => void createGame($)} />
          {run.lines.length > 0 && (
            <Button key="new-game-logs" plain dimColor label={showLogs ? 'Hide log' : 'Log'} onPress={() => void update($, isShowingLogs, value => !value)} />
          )}
        </Box>

        {run.steps.length > 0 && (
          <Box flexDirection="column">
            {run.steps.map(step => (
              <Text key={`step-${step.label}`}>
                <Text color={stepColour(step)}>{stepMark(step)}</Text> {step.label}
                {step.note ? <Text dimColor> {step.note}</Text> : null}
              </Text>
            ))}
          </Box>
        )}
        {run.error && <Text color="error">{run.error}</Text>}
        {run.status === 'done' && (
          <Box flexDirection="column">
            {run.crunchLink && <Link href={run.crunchLink} label="Add it to Crunch" />}
            {run.dest && <Text dimColor>Open {run.dest} in Claude Code, then press Crunch Sync on the band.</Text>}
          </Box>
        )}
        {showLogs && run.lines.slice(-12).map((line, i) => (
          <Text key={`new-game-log-${i}`} dimColor wrap="truncate-end">{line}</Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const root = await $.session.root()
    const { projects, watcher } = await discover($, root)
    const [first] = projects
    if (!first) return next(e)

    const elements = $.ui.resolve(e)
    const { Box, Button, Text, Link } = elements
    // The mobile app draws no Select yet; it gets a button that cycles instead.
    const Select = e.surface !== 'mobile' && 'Select' in elements ? elements.Select : undefined

    const all = await read($, servers)
    const picks = await read($, selected)
    const showLogs = await read($, isShowingLogs)

    const current =
      projects.find(project => project.file === picks[root]) ??
      projects.find(project => isUp(stateOf(all, rojoOf(project).id))) ??
      first
    const rojo = rojoOf(current)
    const rojoState = stateOf(all, rojo.id)
    const others = projects.filter(project => project !== current && isUp(stateOf(all, rojoOf(project).id)))

    const pick = (file: string) => update($, selected, map => ({ ...map, [root]: file }))
    const nextProject = projects[(projects.indexOf(current) + 1) % projects.length] ?? current

    const logged = [rojo, ...(watcher ? [watcher] : [])].filter(server => stateOf(all, server.id).lines.length > 0)

    const watcherControl = watcher && (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text dimColor>│</Text>
        <Button key="watch" plain onPress={() => void toggle($, watcher)}>
          <Text color={colourOf(stateOf(all, watcher.id))}>{dotOf(stateOf(all, watcher.id))}</Text> {watcher.label}{' '}
          <Text dimColor>{detailOf(stateOf(all, watcher.id))}</Text>
        </Button>
      </Box>
    )

    if (await hasSync($, root)) {
      const sync = syncOf(await read($, syncs), root)
      const places = Object.entries(sync.places)
      const url = sync.isUnlinked || sync.needsConfig ? await crunchUrl($) : undefined
      const repo = sync.isUnlinked ? await githubRepoOf($, root) : undefined
      const addLink =
        url && repo
          ? addToCrunchLink(url, {
              name: repo.split('/')[1],
              repo,
              branch: await currentBranch($, root),
              port: await servePortOf($, `${root}/${DEFAULT_PROJECT}`),
            })
          : undefined
      const watchLines = watcher ? stateOf(all, watcher.id).lines : []
      const hasLogs = sync.lines.length > 0 || watchLines.length > 0

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>Crunch</Text>
            <Button key="sync" plain onPress={() => void (syncRunning[root] ? stopSync($, root) : startSync($, root, watcher))}>
              <Text color={syncColour(sync)}>{syncDot(sync)}</Text> {syncLabel(sync)}
              {sync.game ? <Text dimColor> {sync.game}</Text> : null}
            </Button>
            {places.map(([name, place]) => (
              <Text key={`place-${name}`}>
                <Text color={placeColour(place)}>{placeDot(place)}</Text> {name}
                {place.port ? <Text dimColor> :{place.port}</Text> : null}
              </Text>
            ))}
            {sync.page && <Link href={sync.page} label="Sync page" />}
            {addLink && <Link href={addLink} label="Add to Crunch" />}
            {sync.needsConfig && url === undefined && <Text color="warning">Save your Crunch config from Crunch's Setup page</Text>}
            {sync.needsConfig && url !== undefined && <Link href={`${url}/setup#step-config`} label="Set up Crunch" />}
            {watcher && stateOf(all, watcher.id).status !== 'stopped' && (
              <Text key="watching">
                <Text color={colourOf(stateOf(all, watcher.id))}>{dotOf(stateOf(all, watcher.id))}</Text> tree
              </Text>
            )}
            {hasLogs && (
              <Button
                key="logs"
                plain
                dimColor
                label={showLogs ? 'Hide logs' : 'Logs'}
                onPress={() => void update($, isShowingLogs, value => !value)}
              />
            )}
          </Box>
          {sync.status === 'failed' && sync.problem && sync.problem.length > 0 && !showLogs && (
            <Text color="error" wrap="truncate-end">{sync.problem.find(line => line !== '') ?? 'Crunch Sync stopped.'}</Text>
          )}
          {showLogs && sync.lines.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor bold>Crunch Sync</Text>
              {sync.lines.slice(-LOG_LINES_SHOWN * 2).map((line, i) => (
                <Text key={`sync-log-${i}`} dimColor wrap="truncate-end">{line}</Text>
              ))}
            </Box>
          )}
          {showLogs && watchLines.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor bold>{WATCHER.label}</Text>
              {watchLines.slice(-LOG_LINES_SHOWN).map((line, i) => (
                <Text key={`watch-log-${i}`} dimColor wrap="truncate-end">{line}</Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text dimColor>Dev</Text>

          {projects.length === 1 ? (
            <Button key="rojo" plain onPress={() => void serve($, rojo)}>
              <Text color={colourOf(rojoState)}>{dotOf(rojoState)}</Text> Rojo serve{' '}
              <Text dimColor>{detailOf(rojoState)}</Text>
            </Button>
          ) : (
            <Box flexDirection="row" gap={1} alignItems="center">
              {Select ? (
                <Select
                  key="project"
                  label="Rojo"
                  value={current.file}
                  options={projects.map(project => {
                    const state = stateOf(all, rojoOf(project).id)
                    return { value: project.file, label: `${dotOf(state)} ${project.name} ${portOf(state, project.port)}` }
                  })}
                  onSelect={file => void pick(file)}
                />
              ) : (
                <Button key="project" plain dimColor onPress={() => void pick(nextProject.file)}>
                  Rojo: {current.name} ▸
                </Button>
              )}
              <Button key="rojo" plain onPress={() => void serve($, rojo)}>
                <Text color={colourOf(rojoState)}>{dotOf(rojoState)}</Text> {actionOf(rojoState)}{' '}
                <Text dimColor>{detailOf(rojoState, current.port)}</Text>
              </Button>
              {others.map(project => {
                const state = stateOf(all, rojoOf(project).id)
                return (
                  <Button key={`also-${project.file}`} plain dimColor onPress={() => void pick(project.file)}>
                    <Text color={colourOf(state)}>{dotOf(state)}</Text> {project.name}{' '}
                    <Text dimColor>{portOf(state, project.port)}</Text>
                  </Button>
                )
              })}
            </Box>
          )}

          {watcherControl}

          {logged.length > 0 && (
            <Button
              key="logs"
              plain
              dimColor
              label={showLogs ? 'Hide logs' : 'Logs'}
              onPress={() => void update($, isShowingLogs, value => !value)}
            />
          )}
        </Box>

        {showLogs &&
          logged.map(server => (
            <Box key={`log-${server.id}`} flexDirection="column">
              <Text dimColor bold>{server.id === WATCHER.id ? server.label : `Rojo · ${server.label}`}</Text>
              {stateOf(all, server.id).lines.slice(-LOG_LINES_SHOWN).map((line, i) => (
                <Text key={`${server.id}-${i}`} dimColor wrap="truncate-end">
                  {line}
                </Text>
              ))}
            </Box>
          ))}
      </Box>
    )
  })
}
