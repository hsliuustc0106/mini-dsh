import { Agent } from './agent.js'
import { coding } from './coding.js'
import { instructions, Prompt, runtimeContext } from './prompt.js'
import { Permissions } from './permissions.js'
import { fakeProvider } from './provider.js'
import { Checkpoint, Model, Session, Tools, Workspace } from './services.js'

// Consumers are listed before the services they use. Shutdown disposes in
// this order, so a turn can record a known outcome before the session
// releases the writer lock.
export function composition({ workspace, sessionPath, writable = true, provider, approve, model } = {}) {
  return [
    { name: 'agent', plugin: Agent },
    { name: 'coding', plugin: coding },
    { name: 'instructions', plugin: instructions },
    { name: 'runtime-context', plugin: runtimeContext },
    { name: 'permissions', plugin: Permissions, config: { ask: approve } },
    { name: 'checkpoint', plugin: Checkpoint },
    { name: 'tools', plugin: Tools },
    { name: 'prompt', plugin: Prompt },
    { name: 'model', plugin: Model },
    { name: 'provider', plugin: provider ?? fakeProvider(), config: model ?? {} },
    { name: 'session', plugin: Session, config: { path: sessionPath, writable, workspace } },
    { name: 'workspace', plugin: Workspace, config: { root: workspace } },
  ]
}
