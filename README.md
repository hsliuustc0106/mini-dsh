# Mini DeepSeek Harness

A small coding agent for studying [Cordis](https://github.com/cordiverse/cordis) and the [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness). It uses real Cordis services, dependency injection, and reversible effects. It is an independent teaching project, not a DeepSeek Harness profile or a compatible session implementation.

## Run

Requires Node.js 22.13 or newer. `node:sqlite` must stay enabled, which is the default; `--no-experimental-sqlite` disables the session writer lock. A DeepSeek API key is required only when a turn calls the model.

```sh
npm install
export DEEPSEEK_API_KEY='your-key'
export MINI_WORKSPACE="$(pwd)"   # absolute directory; this is the default
npm start
```

`MINI_WORKSPACE` is the required absolute workspace. It is where a session starts. It does not confine filesystem or shell access. A relative path is rejected. `MINI_SESSION` selects the JSONL log. A relative session path is resolved against the workspace, and the default is `.mini-session.jsonl` inside it. `DEEPSEEK_MODEL` defaults to `deepseek-chat`; `DEEPSEEK_BASE_URL` defaults to `https://api.deepseek.com`.

The log contains conversation and tool output, which may include sensitive data. Keep it private. The system prompt is defined in `src/agent.js`. Type `/quit` to exit. The terminal waits for a complete model response before printing it. The agent can read, overwrite, edit, and execute commands with your user account's permissions; use a disposable workspace when experimenting.

## Composition and boot

`src/composition.js` is the coding-agent composition. `boot()` in `src/boot.js` is the shared entry used by the terminal and by tests. It checks the workspace, starts each plugin on its own Cordis fiber, waits until required plugins are active, and disposes every fiber it started when startup fails. A failed or missing plugin is reported by name. Disposing one plugin removes only that plugin's registrations.

## Session log

The log is append-only JSONL. Each complete line is one object with a `seq` starting at 1 and increasing by 1, a `type`, and a `time`. Bytes after the final newline are an incomplete tail, not a record.

- A read-only open leaves the file unchanged and exposes the tail on `session.incompleteTail`.
- A writer copies that tail to `<session>.incomplete` and continues from the valid prefix.
- A complete line that is not valid JSON, or a sequence that does not start at 1 and increase by 1, refuses the session. The file is left unchanged.
- `tool.started` without `tool.finished`, or an assistant message with tool calls and no tool result, is an unknown tool outcome. The session stays readable and refuses further writes. Reacquiring the writer lock does not clear it and does not mean a shell child stopped. Inspect the workspace, then set `MINI_SESSION` to a new file.
- `history(after)` returns events with `seq > after`. `follow(after, listener)` delivers that prefix and then live events with no gap and no duplicate. Pass the last sequence you observed to reconnect. `refresh()` pulls records committed by a writer in another process.
- Events are written before they are published. A failed write is not published.

Checkpoints go through the `checkpoint` service. `commit()` appends one event. `guard(event, work)` runs `work` only after that write completes. A failed write blocks later commits in the process. The durability target is an agent-process crash while the operating system keeps running: the write syscall returning is the checkpoint. This does not promise durability across power loss or a kernel crash.

## Writer lock

One writer owns a session across processes. Observers do not take the lock. Writes inside the writer are serialized.

The lock is a SQLite reserved lock (`BEGIN IMMEDIATE`) on `<session>.lock`, held by Node's built-in `node:sqlite`. That uses an OS advisory lock: `fcntl` on Linux and macOS, `LockFileEx` on Windows. The kernel releases it when the owning process exits, including `SIGKILL`. This was tested on Linux.

Limitations:

- The lock is advisory. A program that appends to the log without it is not stopped.
- `node:sqlite` is experimental. Writer acquisition fails if it is disabled or the runtime is older than Node.js 22.
- Advisory locks on NFS and some network filesystems are unreliable. Use a local filesystem.
- `<session>.lock` and its rollback journal can remain on disk after release. A leftover file does not keep the lock.
- Taking the lock again only means the previous process is gone.

## Study the core

1. `src/composition.js` selects plugins. `src/main.js` boots that composition.
2. `src/services.js` defines the workspace, model, tool registry, checkpoint policy, and session. The agent builds model messages from message events.
3. `src/coding.js` registers tools with `ctx.effect`. Disposing that plugin removes its tools.
4. `src/agent.js` depends on the model, tools, session, and checkpoint. It records an assistant tool call before running it and the result afterwards. Cordis deactivates it if a required service disappears and reactivates it when the service returns.
5. `test/core.test.js`, `test/session.test.js`, and `test/boot.test.js` exercise disposal, replay, the writer lock, recovery, and boot. Run `npm test`. No API key is required.

Approval, a keyless terminal replay, and the trajectory viewer are later slices. This version has no sandbox, compaction, streaming, or full DeepSeek Harness session compatibility.
