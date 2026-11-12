// 'watch', or 'rojo:<project file>' for one rojo serve per *.project.json.
export type ServerId = string

export type ServerState = {
  status: 'stopped' | 'running' | 'stopping' | 'failed'
  lines: string[]
  port?: number
  note?: string
}

// One place Crunch Sync reported, by the name it prints (its project file's name).
export type SyncPlace = { port: number; state: 'starting' | 'syncing' | 'stopped' | 'error' }

// Crunch Sync (the repo's sync/ script) run by the band, per session root.
export type SyncState = {
  status: 'stopped' | 'starting' | 'connected' | 'stopping' | 'failed'
  lines: string[]
  places: Record<string, SyncPlace>
  game?: string
  // The game's Sync page, as the script printed it.
  page?: string
  // Why it stopped, when it said ("Crunch Sync can't start" and what followed).
  problem?: string[]
  // The repo isn't linked to a game in Crunch yet.
  isUnlinked?: boolean
  // ~/.crunch/config.json is missing.
  needsConfig?: boolean
}

export type NewGameForm = {
  name: string
  folder: string
  template: string
  owner: string
  strip: boolean
}

export type NewGameStep = { label: string; state: 'running' | 'done' | 'warn' | 'failed' | 'skipped'; note?: string }

export type NewGameRun = {
  status: 'idle' | 'running' | 'done' | 'failed'
  steps: NewGameStep[]
  lines: string[]
  dest?: string
  repo?: string
  branch?: string
  port?: number
  // "Add to Crunch": the new-game form, prefilled.
  crunchLink?: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'dev-servers': {
      servers: Record<ServerId, ServerState>
      // The project file the Rojo picker points at, per session root.
      selected: Record<string, string>
      isShowingLogs: boolean
      sync: Record<string, SyncState>
      newGameForm: NewGameForm
      newGameRun: NewGameRun
    }
  }
}
