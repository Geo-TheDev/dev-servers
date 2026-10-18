import type { ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
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

test('shows both buttons in a Rojo project', async ($, on) => {
  on('fs.exists', async () => ({ value: true }))
  on('session.root', async () => ({ value: 'C:/proj' }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'dev-servers', surface, ...BAND })
    expect(await ui.find({ key: 'rojo', text: /Rojo serve/ })).toBeDefined()
    expect(await ui.find({ key: 'watch', text: /Watch tree/ })).toBeDefined()
    expect(await ui.find({ key: 'logs' })).toBeUndefined()
    await ui.unmount()
  }
})

test('stays hidden outside a Rojo project', async ($, on) => {
  on('fs.exists', async () => ({ value: false }))
  on('session.root', async () => ({ value: 'C:/other' }))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine band</Text>
  })

  const ui = await $.ui.mount({ plugin: 'dev-servers', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'rojo' })).toBeUndefined()
  await ui.unmount()
})

test('a server that exits on its own shows as failed with its logs', async ($, on) => {
  const started: string[][] = []
  on('fs.exists', async () => ({ value: true }))
  on('session.root', async () => ({ value: 'C:/proj' }))
  on('process.spawn', async function* (_$, e) {
    started.push([...e.argv])
    yield { stream: 'stdout', text: 'Rojo server listening:\n  Port:    34872\n' } satisfies ProcessSpawnChunk
    yield { stream: 'stderr', text: '\x1b[31mport in use\x1b[0m\n' } satisfies ProcessSpawnChunk
    return { value: { code: 1, signal: null } satisfies ProcessSpawnResult }
  })

  const ui = await $.ui.mount({ plugin: 'dev-servers', surface: 'desktop', ...BAND })
  await ui.press({ key: 'rojo' })

  expect(started).toEqual([['rojo', 'serve']])
  expect(await ui.find({ key: 'rojo', text: /exited 1/ })).toBeDefined()

  await ui.press({ key: 'logs' })
  expect(await ui.find({ type: 'Text', text: 'port in use' })).toBeDefined()
  await ui.unmount()
})
