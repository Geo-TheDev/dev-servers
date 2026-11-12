import type { FsEntry, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
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
  on('fs.exists', async (_$, e) => ({ value: !e.path.includes('/sync/') }))

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
  on('fs.exists', async (_$, e) => ({ value: !e.path.includes('/sync/') }))
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
  on('fs.exists', async (_$, e) => ({ value: !e.path.includes('/sync/') }))

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
  on('fs.exists', async (_$, e) => ({ value: !e.path.includes('/sync/') }))
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

const PANE = {
  plugin: 'dev-servers',
  component: 'Pane',
  requestId: 'new-game',
  props: { title: 'New game', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const HOST = JSON.stringify({ platform: 'win32', home: 'C:/Users/me', sep: '/' })

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
declare const setTimeout: (fn: () => void, ms: number) => unknown
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 10))

test('Crunch Sync: one button runs the script and the tree watcher', async ($, on) => {
  const spawned: { argv: string[]; env?: Record<string, string> }[] = []
  on('session.root', async () => ({ value: 'C:/game' }))
  on('fs.list', async () => ({ value: files('default.project.json') }))
  on('fs.exists', async () => ({ value: true }))
  on('process.run', async (_$, e) => (e.argv[0] === 'node' ? ok(HOST) : ok()))
  on('process.spawn', async function* (_$, e) {
    spawned.push({ argv: [...e.argv], env: e.env })
    if (e.argv[0] !== 'powershell.exe') return { value: { code: 0, signal: null } satisfies ProcessSpawnResult }
    yield { stream: 'stdout', text: '[crunch-sync-pid] 4242\r\n' } satisfies ProcessSpawnChunk
    yield { stream: 'stdout', text: '  Game      Bulldozer\n[00:10] Connected. Press Start on the game\'s Sync page to begin syncing:\n  https://crunch.example/games/abc/sync\n' } satisfies ProcessSpawnChunk
    yield { stream: 'stdout', text: '[00:10] Starting default on port 34880...\n[00:10] default syncing on port 34880 - in Studio, open the Rojo plugin and press Connect (port 34880).\n' } satisfies ProcessSpawnChunk
    return { value: { code: 0, signal: null } satisfies ProcessSpawnResult }
  })

  const ui = await $.ui.mount({ plugin: 'dev-servers', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'sync', text: /Crunch Sync/ })).toBeDefined()
  expect(await ui.find({ key: 'rojo' })).toBeUndefined()
  expect(await ui.find({ key: 'watch' })).toBeUndefined()

  await ui.press({ key: 'sync' })

  const sync = spawned.find(s => s.argv[0] === 'powershell.exe')
  expect(spawned.some(s => s.argv.join(' ') === 'node tools/watchTree.js')).toBe(true)
  expect(sync?.env).toEqual({ CRUNCH_SYNC_AUTOSTART: '1' })
  expect(sync?.argv.at(-1)).toContain("& 'C:/game\\sync\\crunch-sync.ps1'")
  expect(await ui.find({ key: 'sync', text: /Crunch Sync Bulldozer/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'Sync page' })).toBeDefined()

  await ui.press({ key: 'logs' })
  expect(await ui.find({ type: 'Text', text: /default syncing on port 34880/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /crunch-sync-pid/ })).toBeUndefined()
  await ui.unmount()
})

test('Crunch Sync: an unlinked repo gets an "Add to Crunch" link, prefilled', async ($, on) => {
  on('session.root', async () => ({ value: 'C:/game' }))
  on('fs.list', async () => ({ value: files('default.project.json') }))
  on('fs.exists', async (_$, e) => ({ value: !e.path.endsWith('tools/watchTree.js') }))
  on('fs.read', async (_$, e) => ({
    value: e.path.endsWith('config.json') ? '{"url":"https://crunch.example/","token":"x"}' : '{"servePort":34880}',
  }))
  on('process.run', async (_$, e) =>
    e.argv[0] === 'node' ? ok(HOST)
    : e.argv.includes('remote') ? ok('git@github.com:me/My-Game.git\n')
    : e.argv.includes('branch') ? ok('main\n')
    : ok(),
  )
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: "\nCrunch Sync can't start\nNo Crunch game is linked to the GitHub repo me/My-Game. Link it to the game in Crunch.\n" } satisfies ProcessSpawnChunk
    return { value: { code: 1, signal: null } satisfies ProcessSpawnResult }
  })

  const ui = await $.ui.mount({ plugin: 'dev-servers', surface: 'desktop', ...BAND })
  await ui.press({ key: 'sync' })
  for (let i = 0; i < 20 && !(await ui.find({ type: 'Link' })); i++) await tick()

  const link = await ui.find({ type: 'Link', text: 'Add to Crunch' })
  expect(link?.props.href).toBe('https://crunch.example/games?new=1&name=My-Game&repo=me%2FMy-Game&branch=main&port=34880')
  expect(await ui.find({ key: 'sync', text: /Retry sync/ })).toBeDefined()
  await ui.unmount()
})

test('New game: makes the project, picks a free port, makes the repo and links to Crunch', async ($, on) => {
  const ran: string[][] = []
  const written: Record<string, string> = {}
  const made = new Set<string>()
  on('command.register', () => ({ value: { command: 'new-game' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', async () => ({ value: 'C:/Games/Example-Project' }))
  on('store.get', async () => ({ value: undefined }))
  on('store.set', async () => ({ value: undefined }))
  on('fs.exists', async (_$, e) => ({
    value: e.path.endsWith('tools/newProject.js') || e.path.endsWith('C:/Games') || [...made].some(path => e.path.endsWith(path)),
  }))
  on('fs.list', async (_$, e) => ({
    value:
      e.path.endsWith('C:/Games') ? [{ name: 'Bulldozer', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : e.path.endsWith('C:/Games/Bulldozer') ? files('default.project.json')
      : [],
  }))
  on('fs.read', async (_$, e) => ({
    value: e.path.endsWith('config.json') ? '{"url":"https://crunch.example"}'
      : e.path.endsWith('C:/Games/Bulldozer/default.project.json') ? '{"servePort":34880}'
      : '{"name":"game","servePort":34872,"tree":{}}',
  }))
  on('fs.write', async (_$, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'node' && e.argv[1] === '-p') return ok(HOST)
    if (e.argv[1] === 'tools/newProject.js') made.add('C:/Games/TycoonSim/.git')
    if (e.argv.includes('remote')) return ok('https://github.com/Geo-TheDev/Example-Project.git\n')
    if (e.argv.includes('branch')) return ok('main\n')
    return ok()
  })

  await $.session.start({ cwd: 'C:/Games/Example-Project', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'new-game', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'template', type: 'Input' })).toBeDefined()
  await ui.input({ key: 'name', text: 'Tycoon Sim', kind: 'change' })
  await ui.press({ key: 'create' })
  for (let i = 0; i < 50 && !(await ui.find({ type: 'Link' })); i++) await tick()

  expect(ran.find(argv => argv[1] === 'tools/newProject.js')).toEqual([
    'node', 'tools/newProject.js', '--name', 'Tycoon Sim', '--dest', 'C:/Games/TycoonSim', '--yes', '--no-color', '--ascii', '--no-strip',
  ])
  expect(JSON.parse(Object.entries(written).find(([path]) => path.endsWith('C:/Games/TycoonSim/default.project.json'))?.[1] ?? '{}').servePort).toBe(34881)
  expect(ran.find(argv => argv[0] === 'gh')).toEqual([
    'gh', 'repo', 'create', 'Geo-TheDev/Tycoon-Sim', '--private', '--source', 'C:/Games/TycoonSim', '--remote', 'origin', '--push',
  ])
  const link = await ui.find({ type: 'Link', text: 'Add it to Crunch' })
  expect(link?.props.href).toBe('https://crunch.example/games?new=1&name=Tycoon%20Sim&repo=Geo-TheDev%2FTycoon-Sim&branch=main&port=34881')
  await ui.unmount()
})

test("Crunch Sync: a repo git won't read (dubious ownership) still gets its link from .git/config", async ($, on) => {
  const gitCalls: string[][] = []
  on('session.root', async () => ({ value: 'E:/Roblox/Game' }))
  on('fs.list', async () => ({ value: files('default.project.json') }))
  on('fs.exists', async (_$, e) => ({ value: !e.path.endsWith('tools/watchTree.js') }))
  on('fs.read', async (_$, e) => ({
    value: e.path.endsWith('config.json') ? '{"url":"https://crunch.example"}'
      : e.path.endsWith('.git/config') ? '[core]\r\n\tbare = false\r\n[remote "upstream"]\r\n\turl = https://github.com/x/y\r\n[remote "origin"]\r\n\turl = https://github.com/me/My-Game.git\r\n'
      : e.path.endsWith('.git/HEAD') ? 'ref: refs/heads/dev\n'
      : '{}',
  }))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'node') return ok(HOST)
    gitCalls.push([...e.argv])
    return { value: { exitCode: 128, stdout: '', stderr: 'fatal: detected dubious ownership', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: "Crunch Sync can't start\nNo Crunch game is linked to the GitHub repo me/My-Game.\n" } satisfies ProcessSpawnChunk
    return { value: { code: 1, signal: null } satisfies ProcessSpawnResult }
  })

  const ui = await $.ui.mount({ plugin: 'dev-servers', surface: 'desktop', ...BAND })
  await ui.press({ key: 'sync' })
  const link = await ui.find({ type: 'Link', text: 'Add to Crunch' })
  expect(link?.props.href).toBe('https://crunch.example/games?new=1&name=My-Game&repo=me%2FMy-Game&branch=dev')
  expect(gitCalls[0]?.slice(0, 3)).toEqual(['git', '-c', 'safe.directory=E:/Roblox/Game'])
  await ui.unmount()
})
