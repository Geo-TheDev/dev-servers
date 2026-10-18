import type { FsEntry, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const files = (...names: string[]): FsEntry[] => names.map(name => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false }))

test('one project: a Rojo serve button and the watcher', async ($, on) => {
  on('session.root', async () => ({ value: 'C:/proj' }))
  on('fs.list', async () => ({ value: files('default.project.json', 'README.md') }))
  on('fs.exists', async () => ({ value: true }))

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'dev-servers', surface, ...BAND })
    expect(await ui.find({ key: 'rojo', text: /Rojo serve/ })).toBeDefined()
    expect(await ui.find({ key: 'project' })).toBeUndefined()
    expect(await ui.find({ key: 'watch', text: /Watch tree/ })).toBeDefined()
    expect(await ui.find({ key: 'logs' })).toBeUndefined()
    await ui.unmount()
  }
})

test('stays hidden without a project file', async ($, on) => {
  on('session.root', async () => ({ value: 'C:/other' }))
  on('fs.list', async () => ({ value: files('package.json') }))
  on('fs.exists', async () => ({ value: false }))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine band</Text>
  })

  const ui = await $.ui.mount({ plugin: 'dev-servers', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'rojo' })).toBeUndefined()
  await ui.unmount()
})

test('hides the watcher when the repo has no watch script', async ($, on) => {
  on('session.root', async () => ({ value: 'C:/proj' }))
  on('fs.list', async () => ({ value: files('default.project.json') }))
  on('fs.exists', async () => ({ value: false }))

  const ui = await $.ui.mount({ plugin: 'dev-servers', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'rojo' })).toBeDefined()
  expect(await ui.find({ key: 'watch' })).toBeUndefined()
  await ui.unmount()
})

test('several places: default is hidden, each serves on the default port', async ($, on) => {
  const started: string[][] = []
  on('session.root', async () => ({ value: 'C:/proj' }))
  on('fs.list', async () => ({ value: files('Lobby.project.json', 'default.project.json', 'Game.project.json') }))
  on('fs.exists', async () => ({ value: true }))
  on('process.spawn', async function* (_$, e) {
    started.push([...e.argv])
    yield { stream: 'stdout', text: `  Port:    ${e.argv[4]}\n` } satisfies ProcessSpawnChunk
    return { value: { code: 1, signal: null } satisfies ProcessSpawnResult }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'dev-servers', surface, ...BAND })
    expect(await ui.find({ key: 'project' })).toBeDefined()
    expect(await ui.find({ key: 'rojo', text: /Serve/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'dev-servers', surface: 'desktop', ...BAND })
  await ui.select({ key: 'project', value: 'Game.project.json' })
  await ui.press({ key: 'rojo' })
  expect(started).toEqual([['rojo', 'serve', 'Game.project.json', '--port', '34872']])

  await ui.select({ key: 'project', value: 'Lobby.project.json' })
  await ui.press({ key: 'rojo' })
  expect(started[1]).toEqual(['rojo', 'serve', 'Lobby.project.json', '--port', '34872'])
  await ui.unmount()
})

test('mobile cycles projects with a button', async ($, on) => {
  on('session.root', async () => ({ value: 'C:/proj' }))
  on('fs.list', async () => ({ value: files('default.project.json', 'Lobby.project.json', 'Game.project.json') }))
  on('fs.exists', async () => ({ value: true }))

  const ui = await $.ui.mount({ plugin: 'dev-servers', surface: 'mobile', ...BAND })
  expect(await ui.find({ key: 'project', text: /Game/ })).toBeDefined()
  await ui.press({ key: 'project' })
  expect(await ui.find({ key: 'project', text: /Lobby/ })).toBeDefined()
  await ui.press({ key: 'project' })
  expect(await ui.find({ key: 'project', text: /Game/ })).toBeDefined()
  await ui.unmount()
})

test('a server that exits on its own shows as failed with its logs', async ($, on) => {
  const started: string[][] = []
  on('session.root', async () => ({ value: 'C:/proj' }))
  on('fs.list', async () => ({ value: files('default.project.json') }))
  on('fs.exists', async () => ({ value: true }))
  on('process.spawn', async function* (_$, e) {
    started.push([...e.argv])
    yield { stream: 'stdout', text: 'Rojo server listening:\n  Port:    34872\n' } satisfies ProcessSpawnChunk
    yield { stream: 'stderr', text: '\x1b[31mport in use\x1b[0m\n' } satisfies ProcessSpawnChunk
    return { value: { code: 1, signal: null } satisfies ProcessSpawnResult }
  })

  const ui = await $.ui.mount({ plugin: 'dev-servers', surface: 'desktop', ...BAND })
  await ui.press({ key: 'rojo' })

  expect(started).toEqual([['rojo', 'serve', 'default.project.json', '--port', '34872']])
  expect(await ui.find({ key: 'rojo', text: /exited 1/ })).toBeDefined()

  await ui.press({ key: 'logs' })
  expect(await ui.find({ type: 'Text', text: 'port in use' })).toBeDefined()
  await ui.unmount()
})
