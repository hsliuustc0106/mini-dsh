# Mini DeepSeek Harness

A small coding agent for studying [Cordis](https://github.com/cordiverse/cordis) and the [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness). It uses real Cordis services, dependency injection, and reversible effects. It is an independent teaching project, not a DeepSeek Harness profile or a compatible session implementation.

## Run

Requires Node.js 22.13 or newer. `node:sqlite` must stay enabled, which is the default; `--no-experimental-sqlite` disables the session writer lock. Interactive use calls DeepSeek when a credential is set. Tests and replay stay on the prepared fake provider and do not need a key.

```sh
npm install
export MINI_WORKSPACE="$(pwd)"   # absolute directory; this is the default
npm start
```

`MINI_WORKSPACE` is the required absolute workspace. It is where a session starts. Relative file paths resolve against it, and shell commands use it as their working directory. It does not confine filesystem or shell access. A relative workspace path is rejected. `MINI_SESSION` selects the JSONL log. A relative session path is resolved against the workspace, and the default is `.mini-session.jsonl` inside it.

The read-only `glob` and `grep` tools use the bundled ripgrep binary; no system `rg` installation is needed. `glob` takes `pattern` and optional `path`, returns files in modification-time order, and includes hidden and ignored files while excluding VCS metadata. `grep` takes a ripgrep regex `pattern`, optional file or directory `path`, and optional `include` with one positive glob, such as `*.{js,ts}`. It follows ripgrep's normal hidden-file and ignore rules; an explicit `include` may override an ignore rule. Results are relative to the workspace when possible. Both tools accept absolute paths and can read outside the workspace, like `read`. Search calls time out after 30 seconds and fail if raw output exceeds 20 MB. `glob` shows up to 100 paths and `grep` up to 250 matches, with a truncation notice; narrow the search to see more.

The log contains conversation and tool output, which may include sensitive data. Keep it private. Ordered prompt plugins supply the system prompt and the runtime context. Type `/quit` to exit. The terminal prints an assistant message after that stream has been committed. Read-only tools are allowed. Each write, edit, and shell call asks once for that exact call. Answer `y` or `yes` to grant it; any other answer denies it. Closing the input does not grant it, and the terminal does not ask again for that call. With no answer yet, the terminal waits and does not run the tool. An approved shell command runs with your user account's permissions. The workspace is its working directory, not a sandbox. Use a disposable directory when experimenting.

`MINI_REPLIES` is an optional JSON file of prepared fake-model responses. A relative path is resolved from the process working directory. It selects the fake provider even when a DeepSeek key is set, which is how tests and replay stay keyless. Without it and without a key, the fake provider has no replies. `MINI_CLOCK`, when set, is the timestamp stored on each new event. `MINI_INSPECT=1` prints the session as JSONL and exits. It does not take the writer lock, append, or run a tool. A session with an unknown tool outcome still prints; the process exits with an error and does not retry the tool. The interactive entry refuses before accepting input: inspect the workspace, then choose a new `MINI_SESSION`. A pending approval is not a grant. Killing the process while a prompt is open leaves that outcome unknown.

Set `DEEPSEEK_API_KEY` to use the live provider for `npm start`. The key can also be one line in a file that is not committed: set `DEEPSEEK_API_KEY_FILE` to that path. `.env` is gitignored. Do not commit a key, and do not put one in a fixture. DeepSeek is called with the OpenAI-compatible chat completions API. The default base URL is `https://api.deepseek.com` (`DEEPSEEK_BASE_URL` overrides it). The default model is `deepseek-flash` (`DEEPSEEK_MODEL` overrides it). Each call is `POST /chat/completions` with `stream` true and thinking disabled. Tokens arrive as server-sent events and end with `data: [DONE]`. The session records that request body on `model.request` before the call, then `stream.started`, one `stream.delta` per observed text or tool-call fragment, and `stream.ended` with the finish that was observed. The assistant message is written only after a complete finish (`stop`, `length`, `tool_calls`, or `content_filter`), and its text is the concatenation of those deltas. An aborted, interrupted, or unfinished stream stays an unknown outcome and does not gain a message that was never committed. The key is sent only as an `Authorization: Bearer` header. It is not part of the body and it is not written to the session. `DEEPSEEK_TOOL_CHOICE` names one tool on the first request of a turn. Leave it unset for normal use.

`npm run smoke` is a manual live turn. It is not part of `npm test` or `npm run replay`. Without a key it prints a skip message and exits. With a key it runs one terminal turn in a temporary workspace and checks the session for the non-secret request body, the assistant response, the read permission, and the tool result. The smoke asks the model to read `smoke.txt` and sets `DEEPSEEK_TOOL_CHOICE=read` for that first request. Read is allowed. Write, edit, and shell still ask; the smoke denies those. Approval is not a sandbox. The recorded runtime context includes `"sandbox": false`. The same command is the manual GitHub Actions workflow `smoke`, which reads the `DEEPSEEK_API_KEY` repository secret and skips when that secret is absent. Default CI does not run it.

`npm run view` serves a local read-only trajectory of that session at `http://127.0.0.1:7483`. It does not take the writer lock, accept a prompt, or approve a tool. The page shows a mini-dsh wordmark, a timing overview of input, model, and tool spans, the observed stream fragments and their timestamps, and a chronological ledger grouped by turn. Selecting a row shows the recorded request, arguments, result, or error. An interrupted tool or stream stays an unknown outcome, and the page keeps serving that history. `MINI_VIEW_PORT` chooses the port, including `0` for an ephemeral port.

`MINI_VIEW=1` serves the same page beside the interactive terminal and follows the open session. Inspect mode ignores it. The viewer reads the session log. It does not keep a second history. A reconnect continues from the last sequence it observed. Terminal input and approvals stay in the terminal.

## Composition and boot

`src/composition.js` is the coding-agent composition. `boot()` in `src/boot.js` is the shared entry used by the terminal and by tests. It checks the workspace, starts each plugin on its own Cordis fiber, waits until required plugins are active, and disposes every fiber it started when startup fails. A failed or missing plugin is reported by name. Disposing one plugin removes only that plugin's registrations.

## Session log

The log is append-only JSONL. Each complete line is one object with a `seq` starting at 1 and increasing by 1, a `type`, and a `time`. Bytes after the final newline are an incomplete tail, not a record.

- A read-only open leaves the file unchanged and exposes the tail on `session.incompleteTail`.
- A writer copies that tail to `<session>.incomplete` and continues from the valid prefix.
- A complete line that is not valid JSON, or a sequence that does not start at 1 and increase by 1, refuses the session. The file is left unchanged.
- `tool.started` without `tool.finished`, or an assistant message with tool calls and no tool result, is an unknown tool outcome. `stream.started` without a complete `stream.ended` and the following assistant message is an unknown stream outcome. An incomplete finish (`aborted`, `insufficient_system_resource`) stays unknown. The session stays readable and refuses further writes. Reacquiring the writer lock does not clear it and does not fill in text or a tool result that was never written. Inspect the workspace, then set `MINI_SESSION` to a new file.
- `history(after)` returns events with `seq > after`. `follow(after, listener)` delivers that prefix and then live events with no gap and no duplicate. Pass the last sequence you observed to reconnect. `refresh()` pulls records committed by a writer in another process.
- Events are written before they are published. A failed write is not published.

A turn also records `model.request` (the provider body, with no credentials), `stream.started`, `stream.delta`, and `stream.ended` before the assistant message, `permission.decided` (the workspace, the exact arguments, and allow or deny), `tool.started` before the tool body, and `tool.finished` with the observed result. Each stream record is written before it is published and before the next chunk is accepted. Opening a session does not fill in a missing result or a missing tail of the reply.

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
3. `src/coding.js` registers read, write, edit, shell, and the glob and grep tools from `src/search.js` with `ctx.effect`. Relative paths and the shell working directory come from the boot workspace. Disposing that plugin removes its tools.
4. `src/prompt.js` collects ordered instruction and runtime-context contributions for the life of the plugin that added them. Context describes the workspace and the permission policy. It does not enforce them.
5. `src/permissions.js` allows read, glob, and grep, asks for each exact write, edit, or shell call, and denies unknown tools. Only an answer of `true` is a grant. The terminal supplies that answer once per call. Approval is not a sandbox.
6. `src/provider.js` registers one provider. `MINI_REPLIES` registers the fake provider. A credential with no replies registers DeepSeek. Each model call is prepared once. The prepared body is the request that will be sent. DeepSeek's body is the chat-completions JSON, without the API key. `dispatch()` yields that call's chunks once.
7. `src/agent.js` runs one turn at a time. It records that body before dispatch, commits each observed chunk before reading the next, and writes the assistant message from those committed deltas only after a complete finish. It then checkpoints `tool.started` before each tool body and records the observed result after. A second turn is rejected as busy. Shutdown stops new turns, cancels a pending approval, drains a tool body that already started, and does not invent a result or reply text that was never observed.
8. `test/core.test.js`, `test/session.test.js`, `test/boot.test.js`, `test/agent.test.js`, `test/terminal.test.js`, `test/trajectory.test.js`, and `test/provider.test.js` exercise disposal, replay, the writer lock, recovery, boot, the keyless loop, the terminal entry point, the trajectory projection, and the DeepSeek request body with a mocked HTTP call. Run `npm test`. `npm run replay` runs the terminal replay on its own. No API key is required. `npm run smoke` is the live check.
9. `src/trajectory.js` projects session events into turns, timing spans, and the observed stream fragments. `src/viewer.js` serves that projection on `127.0.0.1`. The server is a `ctx.effect` registration, so unloading the plugin closes it. `npm run view` opens the log read-only. `MINI_VIEW=1` follows a live terminal session from the same session service. Reconnect with the last sequence you observed.

`fixtures/write-hello/` is the recorded fake-model task: prepared replies, the session log, and `hello.txt`. The replay drives `src/main.js` in an explicit workspace and checks the session events and that file. Those replies are streamed into the session as deltas. The trajectory viewer projects that same log, including an interrupted tool with no recorded result. Live DeepSeek is the interactive provider and `npm run smoke`. This version has no sandbox, compaction, or full DeepSeek Harness session compatibility. CI runs the same keyless suite and does not call DeepSeek.
