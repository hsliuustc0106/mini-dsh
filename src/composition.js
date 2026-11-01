import { Agent } from './agent.js'
import { coding } from './coding.js'
import { instructions, Prompt, runtimeContext } from './prompt.js'
import { defaultToolPermissions, Permissions } from './permissions.js'
import { fakeProvider } from './provider.js'
import { Checkpoint, Model, Session, Tools, Workspace } from './services.js'
import { skills } from './skills.js'
import { Terminal } from './terminal.js'
import { TrajectoryViewer } from './viewer.js'
import { WebControl } from './web-control.js'

// Consumers are listed before the services they use. Shutdown disposes in
// this order, so a turn can record a known outcome before the session
// releases the writer lock.
function viewerEntry(view) {
  if (!view) return null
  return { name: 'viewer', plugin: TrajectoryViewer, config: view === true ? {} : view }
}

export function composition({ workspace, sessionPath, writable = true, provider, approve, model, clock, view, web, skillOptions, terminal } = {}) {
  const viewer = viewerEntry(view)
  return [
    ...(viewer ? [viewer] : []),
    ...(web ? [{ name: 'web-control', plugin: WebControl, config: web === true ? {} : web }] : []),
    ...(terminal ? [{ name: 'terminal', plugin: Terminal, config: terminal }] : []),
    { name: 'agent', plugin: Agent },
    { name: 'coding', plugin: coding },
    { name: 'skills', plugin: skills, config: skillOptions },
    { name: 'instructions', plugin: instructions },
    { name: 'runtime-context', plugin: runtimeContext },
    { name: 'default-tool-permissions', plugin: defaultToolPermissions },
    { name: 'permissions', plugin: Permissions, config: { ask: approve } },
    { name: 'checkpoint', plugin: Checkpoint },
    { name: 'tools', plugin: Tools },
    { name: 'prompt', plugin: Prompt },
    { name: 'model', plugin: Model },
    // Tests and replay pass the fake provider. The terminal passes DeepSeek when a key is set.
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
