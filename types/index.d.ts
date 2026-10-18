// 'watch', or 'rojo:<project file>' for one rojo serve per *.project.json.
export type ServerId = string

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
      // The project file the Rojo picker points at, per session root.
      selected: Record<string, string>
      isShowingLogs: boolean
    }
  }
}
