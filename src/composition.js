import { Agent } from './agent.js'
import { coding } from './coding.js'
import { instructions, Prompt, runtimeContext } from './prompt.js'
import { Permissions } from './permissions.js'
import { fakeProvider } from './provider.js'
import { Checkpoint, Model, Session, Tools, Workspace } from './services.js'
import { TrajectoryViewer } from './viewer.js'

// Consumers are listed before the services they use. Shutdown disposes in
// this order, so a turn can record a known outcome before the session
// releases the writer lock.
function viewerEntry(view) {
  if (!view) return null
  return { name: 'viewer', plugin: TrajectoryViewer, config: view === true ? {} : view }
}

export function composition({ workspace, sessionPath, writable = true, provider, approve, model, clock, view } = {}) {
  const viewer = viewerEntry(view)
  return [
    ...(viewer ? [viewer] : []),
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
    { name: 'session', plugin: Session, config: { path: sessionPath, writable, workspace, clock } },
    { name: 'workspace', plugin: Workspace, config: { root: workspace } },
  ]
}

// Read-only. The terminal keeps input and approval; this composition only projects the log.
export function viewerComposition({ workspace, sessionPath, view } = {}) {
  return [
    { name: 'viewer', plugin: TrajectoryViewer, config: view ?? {} },
    { name: 'session', plugin: Session, config: { path: sessionPath, writable: false, workspace } },
  ]
}
