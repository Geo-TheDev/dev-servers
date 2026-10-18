export type ServerId = 'rojo' | 'watch'

export type ServerState = {
  status: 'stopped' | 'running' | 'stopping' | 'failed'
  lines: string[]
  port?: number
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'dev-servers': {
      servers: Record<ServerId, ServerState>
      isShowingLogs: boolean
    }
  }
}
