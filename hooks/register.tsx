import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { ServerId, ServerState } from '../types'

type Server = { id: ServerId; label: string; argv: string[] }

const SERVERS: Server[] = [
  { id: 'rojo', label: 'Rojo serve', argv: ['rojo', 'serve'] },
  { id: 'watch', label: 'Watch tree', argv: ['node', 'tools/watchTree.js'] },
]

const PROJECT_FILE = 'default.project.json'
const MAX_LINES = 40
const LOG_LINES_SHOWN = 6
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const PORT = /Port:\s*(\d+)/i

const STOPPED: ServerState = { status: 'stopped', lines: [] }

const servers = atom({ plugin: 'dev-servers', key: 'servers' } as const, { rojo: STOPPED, watch: STOPPED })
const isShowingLogs = atom({ plugin: 'dev-servers', key: 'isShowingLogs' } as const, false)

const running: Partial<Record<ServerId, HookStream<ProcessSpawnChunk, ProcessSpawnResult>>> = {}
const projectChecks = new Map<string, boolean>()

const isRojoProject = async ($: EngineInterface) => {
  const root = await $.session.root()
  const known = projectChecks.get(root)
  if (known !== undefined) return known

  const found = await $.fs.exists(`${root}/${PROJECT_FILE}`)
  projectChecks.set(root, found)
  return found
}

const patch = ($: EngineInterface, id: ServerId, fn: (state: ServerState) => ServerState) =>
  update($, servers, all => ({ ...all, [id]: fn(all[id]) }))

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

const dotOf = (state: ServerState) =>
  state.status === 'running' ? '●'
  : state.status === 'stopping' ? '◐'
  : state.status === 'failed' ? '✕'
  : '○'

const colourOf = (state: ServerState) =>
  state.status === 'running' ? 'success'
  : state.status === 'failed' ? 'error'
  : 'subtle'

const detailOf = (state: ServerState) =>
  state.status === 'running' && state.port !== undefined ? `:${state.port}`
  : state.status === 'running' ? 'running'
  : state.status === 'stopping' ? 'stopping'
  : state.status === 'failed' ? (state.note ?? 'failed')
  : 'start'

export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await isRojoProject($))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const all = await read($, servers)
    const showLogs = await read($, isShowingLogs)
    const withLogs = SERVERS.filter(server => all[server.id].lines.length > 0)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text dimColor>Dev</Text>
          {SERVERS.map(server => {
            const state = all[server.id]
            return (
              <Button key={server.id} plain onPress={() => void toggle($, server)}>
                <Text color={colourOf(state)}>{dotOf(state)}</Text> {server.label}{' '}
                <Text dimColor>{detailOf(state)}</Text>
              </Button>
            )
          })}
          {withLogs.length > 0 && (
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
          withLogs.map(server => (
            <Box key={`log-${server.id}`} flexDirection="column">
              <Text dimColor bold>{server.label}</Text>
              {all[server.id].lines.slice(-LOG_LINES_SHOWN).map((line, i) => (
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
