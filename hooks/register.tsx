import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { ServerId, ServerState } from '../types'

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

export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const root = await $.session.root()
    const { projects, watcher } = await discover($, root)
    const [first] = projects
    if (!first) return next(e)

    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
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

          {watcher && (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text dimColor>│</Text>
              <Button key="watch" plain onPress={() => void toggle($, watcher)}>
                <Text color={colourOf(stateOf(all, watcher.id))}>{dotOf(stateOf(all, watcher.id))}</Text> {watcher.label}{' '}
                <Text dimColor>{detailOf(stateOf(all, watcher.id))}</Text>
              </Button>
            </Box>
          )}

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
