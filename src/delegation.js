import { AsyncLocalStorage } from 'node:async_hooks'

// The official subagent tool reads exec.agent. Root stays the mini-dsh handle.
// A child run installs its own agent for nested tool calls and depth checks.
export const delegationStore = new AsyncLocalStorage()

export function rootDelegationAgent() {
  return {
    id: 'mini-dsh',
    depth: 0,
    options: { subagentDepth: 0 },
    session: { header: { delegationDepth: 0 } },
  }
}

export function currentDelegationAgent() {
  return delegationStore.getStore()?.agent ?? rootDelegationAgent()
}
