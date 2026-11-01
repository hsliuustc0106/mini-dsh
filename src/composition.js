import { Agent } from './agent.js'
import { coding } from './coding.js'
import { Checkpoint, Model, Session, Tools, Workspace } from './services.js'

// The coding-agent composition. Each entry is its own Cordis plugin and is
// disposed on its own. Consumers are listed before the services they use.
export function composition({ workspace, sessionPath, model, writable = true } = {}) {
  return [
    { name: 'agent', plugin: Agent },
    { name: 'coding', plugin: coding },
    { name: 'checkpoint', plugin: Checkpoint },
    { name: 'tools', plugin: Tools },
    { name: 'model', plugin: Model, config: model ?? {} },
    { name: 'session', plugin: Session, config: { path: sessionPath, writable, workspace } },
    { name: 'workspace', plugin: Workspace, config: { root: workspace } },
  ]
}
