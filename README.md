# Mini DeepSeek Harness

A small coding agent for studying [Cordis](https://github.com/cordiverse/cordis) and the [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness). It uses real Cordis services, dependency injection, and reversible effects. It is an independent teaching project, not a DeepSeek Harness profile or a compatible session implementation.

## Run

Requires Node.js 22.13 or newer. `node:sqlite` must stay enabled, which is the default; `--no-experimental-sqlite` disables the session writer lock. This slice does not call DeepSeek. A turn uses the prepared fake provider; the live provider is a later slice.

```sh
npm install
export MINI_WORKSPACE="$(pwd)"   # absolute directory; this is the default
npm start
```

`MINI_WORKSPACE` is the required absolute workspace. It is where a session starts. Relative file paths resolve against it, and shell commands use it as their working directory. It does not confine filesystem or shell access. A relative workspace path is rejected. `MINI_SESSION` selects the JSONL log. A relative session path is resolved against the workspace, and the default is `.mini-session.jsonl` inside it.

The log contains conversation and tool output, which may include sensitive data. Keep it private. Ordered prompt plugins supply the system prompt and the runtime context. Type `/quit` to exit. The terminal waits for a complete model response before printing it. Read is allowed. Each write, edit, and shell call asks once for that exact call. Answer `y` or `yes` to grant it; any other answer denies it. Closing the input does not grant it, and the terminal does not ask again for that call. With no answer yet, the terminal waits and does not run the tool. An approved shell command runs with your user account's permissions. The workspace is its working directory, not a sandbox. Use a disposable directory when experimenting.

`MINI_REPLIES` is an optional JSON file of prepared fake-model responses. A relative path is resolved from the process working directory. Without it, the fake provider has no replies. `MINI_CLOCK`, when set, is the timestamp stored on each new event. `MINI_INSPECT=1` prints the session as JSONL and exits. It does not take the writer lock, append, or run a tool. A session with an unknown tool outcome still prints; the process exits with an error and does not retry the tool. The interactive entry refuses before accepting input: inspect the workspace, then choose a new `MINI_SESSION`. A pending approval is not a grant. Killing the process while a prompt is open leaves that outcome unknown.

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

A turn also records `model.request` (the provider body, with no credentials), `permission.decided` (the workspace, the exact arguments, and allow or deny), `tool.started` before the tool body, and `tool.finished` with the observed result. Opening a session does not fill in a missing result.

Checkpoints go through the `checkpoint` service. `commit()` appends one event. `guard(event, work)` runs `work` only after that write completes. The agent guards each tool start, so the body does not run until `tool.started` is durable. A failed write blocks later commits in the process and does not invent a tool result. The durability target is an agent-process crash while the operating system keeps running: the write syscall returning is the checkpoint. This does not promise durability across power loss or a kernel crash.

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

1. `src/composition.js` selects plugins. `src/main.js` boots that composition. Shutdown disposes consumers first, so a turn can record a known outcome before the session releases its writer lock.
2. `src/services.js` defines the workspace, the model provider registry, the tool registry, the checkpoint policy, and the session. The agent builds model messages from message events.
3. `src/coding.js` registers read, write, edit, and shell with `ctx.effect`. Relative paths and the shell working directory come from the boot workspace. Disposing that plugin removes its tools.
4. `src/prompt.js` collects ordered instruction and runtime-context contributions for the life of the plugin that added them. Context describes the workspace and the permission policy. It does not enforce them.
5. `src/permissions.js` allows read, asks for each exact write, edit, or shell call, and denies unknown tools. Only an answer of `true` is a grant. The terminal supplies that answer once per call. Approval is not a sandbox.
6. `src/provider.js` registers the fake provider. Each model call is prepared once. The prepared body is the request that will be sent.
7. `src/agent.js` runs one turn at a time. It records that body before dispatch, then checkpoints `tool.started` before each tool body and records the observed result after. A second turn is rejected as busy. Shutdown stops new turns, cancels a pending approval, drains a tool body that already started, and does not invent a result that was never observed.
8. `test/core.test.js`, `test/session.test.js`, `test/boot.test.js`, `test/agent.test.js`, and `test/terminal.test.js` exercise disposal, replay, the writer lock, recovery, boot, the keyless loop, and the terminal entry point. Run `npm test`. `npm run replay` runs the terminal replay on its own. No API key is required.

`fixtures/write-hello/` is the recorded fake-model task: prepared replies, the session log, and `hello.txt`. The replay drives `src/main.js` in an explicit workspace and checks the session events and that file. The trajectory viewer is a later slice. This version has no live DeepSeek provider, sandbox, compaction, streaming, or full DeepSeek Harness session compatibility. CI runs the same keyless suite and does not call DeepSeek.
