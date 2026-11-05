# Mini DeepSeek Harness

A small coding agent for studying [Cordis](https://github.com/cordiverse/cordis) and the [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness). It uses real Cordis services, dependency injection, and reversible effects. It is an independent teaching project, not a DeepSeek Harness profile or a compatible session implementation.

## Run

Requires Node.js 22.13 or newer. `node:sqlite` must stay enabled, which is the default; `--no-experimental-sqlite` disables the session writer lock. Interactive use calls DeepSeek when a credential is set. Tests and replay stay on the prepared fake provider and do not need a key.

```sh
npm install
export MINI_WORKSPACE="$(pwd)"   # absolute directory; this is the default
npm start
```

`MINI_WORKSPACE` is the required absolute workspace. It is where a session starts. Relative file paths resolve against it, and shell commands use it as their working directory. Mini-dsh does **not** `chdir` into that directory; the process working directory may differ. Relative paths for coding tools and installed plugins resolve against the workspace root only — never `process.cwd()`. Missing or non-absolute workspace fails at boot. Absolute paths still pass through unchanged. The workspace does **not** confine filesystem or shell access (it is not a sandbox). A relative workspace path is rejected. `MINI_SESSION` selects the JSONL log. A relative session path is resolved against the workspace, and the default is `.mini-session.jsonl` inside it.

The read-only `glob` and `grep` tools use the bundled ripgrep binary; no system `rg` installation is needed. `glob` takes `pattern` and optional `path`, returns files in modification-time order, and includes hidden and ignored files while excluding VCS metadata. `grep` takes a ripgrep regex `pattern`, optional file or directory `path`, and optional `include` with one positive glob, such as `*.{js,ts}`. It follows ripgrep's normal hidden-file and ignore rules; an explicit `include` may override an ignore rule. Results are relative to the workspace when possible. Both tools accept absolute paths and can read outside the workspace, like `read`. Search calls time out after 30 seconds and fail if raw output exceeds 20 MB. `glob` shows up to 100 paths and `grep` up to 250 matches, with a truncation notice; narrow the search to see more.

The log contains conversation and tool output, which may include sensitive data. Keep it private. Ordered prompt plugins supply the system prompt and the runtime context. Type `/quit` to exit. The terminal prints an assistant message after that stream has been committed. Read-only tools are allowed. Each write, edit, and shell call asks once for that exact call. Answer `y` or `yes` to grant it; any other answer denies it. Closing the input does not grant it, and the terminal does not ask again for that call. With no answer yet, the terminal waits and does not run the tool. An approved shell command runs with your user account's permissions. The workspace is its working directory, not a sandbox. Use a disposable directory when experimenting.

`MINI_REPLIES` is an optional JSON file of prepared fake-model responses. A relative path is resolved from the process working directory. It selects the fake provider even when a DeepSeek key is set, which is how tests and replay stay keyless. Without it and without a key, the fake provider has no replies. `MINI_CLOCK`, when set, is the timestamp stored on each new event. `MINI_INSPECT=1` prints the session as JSONL and exits. It does not take the writer lock, append, or run a tool. A session with an unknown tool outcome still prints; the process exits with an error and does not retry the tool. The interactive entry refuses before accepting input: inspect the workspace, then choose a new `MINI_SESSION`. A pending approval is not a grant. Killing the process while a prompt is open leaves that outcome unknown.

Set `DEEPSEEK_API_KEY` to use the live provider for `npm start`. The key can also be one line in a file that is not committed: set `DEEPSEEK_API_KEY_FILE` to that path. `.env` is gitignored. Do not commit a key, and do not put one in a fixture. DeepSeek is called with the OpenAI-compatible chat completions API. The default base URL is `https://api.deepseek.com` (`DEEPSEEK_BASE_URL` overrides it). The default model is `deepseek-flash` (`DEEPSEEK_MODEL` overrides it). Each call is `POST /chat/completions` with `stream` true and thinking disabled. Tokens arrive as server-sent events and end with `data: [DONE]`. The session records that request body on `model.request` before the call, then `stream.started`, one `stream.delta` per observed text or tool-call fragment, and `stream.ended` with the finish that was observed. The assistant message is written only after a complete finish (`stop`, `length`, `tool_calls`, or `content_filter`), and its text is the concatenation of those deltas. An aborted, interrupted, or unfinished stream stays an unknown outcome and does not gain a message that was never committed. The key is sent only as an `Authorization: Bearer` header. It is not part of the body and it is not written to the session. `DEEPSEEK_TOOL_CHOICE` names one tool on the first request of a turn. Leave it unset for normal use.

`npm run smoke` is a manual live turn. It is not part of `npm test` or `npm run replay`. Without a key it prints a skip message and exits. With a key it runs one terminal turn in a temporary workspace and checks the session for the non-secret request body, the assistant response, the read permission, and the tool result. The smoke asks the model to read `smoke.txt` and sets `DEEPSEEK_TOOL_CHOICE=read` for that first request. Read is allowed. Write, edit, and shell still ask; the smoke denies those. Approval is not a sandbox. The recorded runtime context includes `"sandbox": false`. The same command is the manual GitHub Actions workflow `smoke`, which reads the `DEEPSEEK_API_KEY` repository secret and skips when that secret is absent. Default CI does not run it.

`npm run benchmark:prompts` compares the previous and current prompts on coding tasks and reports model calls, latency, and behavioral quality. Keyless tests run in pull-request CI; a separate live GitHub Actions workflow runs on main and by manual dispatch when the `DEEPSEEK_API_KEY` secret is configured. See the [coding benchmark](benchmarks/coding/README.md) for the task restrictions, results, and options.

`npm run view` serves a local read-only trajectory of that session at `http://127.0.0.1:7483`. It does not take the writer lock. `/` does not accept a prompt or approve a tool. The page shows a timeline, conversation cards, and an expandable chronological event ledger. Select an event on a card, a timeline span, a stream fragment, or a ledger row to inspect its recorded detail. An interrupted tool or stream stays an unknown outcome, and the page keeps serving that history. `MINI_VIEW_PORT` chooses the port, including `0` for an ephemeral port.

## Event-driven projection

The append-only session log is the source of truth. The trajectory, the read-only viewer, and the live web controls recompute from that log.

Streams, asks, and tools are events. A model call records `model.request`, then `stream.started`, one `stream.delta` per observed fragment, and `stream.ended`. The assistant message is those committed deltas, written after a complete finish. An ask records `permission.decided` for that exact call. The web **Allow once** / **Deny** card is the open ask on that connection; the click posts the ask, and the decision appears when the session records it. A disconnect does not grant the call. A tool records `tool.started` before the body and `tool.finished` with the observed result. A missing finish stays an unknown outcome.

`project()` in `src/trajectory.js` rebuilds turns, cards, and spans from the event list it is given. The viewer page and both `GET /trajectory` routes call it on `session.events`. The web transcript walks the followed events in order. `test/event-driven.test.js` projects a full log and then a shorter or different one: a cached stream fragment, ask, or tool result fails that check.

The surfaces are projections of the same append-only session:

| Surface | Session records |
| --- | --- |
| USER card | User `message` |
| ASSISTANT card | Committed assistant `message`; observed text from an uncommitted stream is shown as partial with an unknown outcome |
| TOOL card | Assistant tool call, its `permission.decided`, `tool.started` / `tool.finished`, and matching tool `message`, when recorded |
| Timeline and fragments | User messages, `model.request` and `stream.*`, and `tool.started` / `tool.finished`; fragments retain their event timestamps |
| Event ledger and detail | All recorded events in sequence, including request bodies and decisions |

Tool cards distinguish denied, error, and unknown outcomes and never fill in a missing result. Card event buttons and the ledger lead to the underlying records, including the permission decision. The timeline groups fragments by model request and keeps each fragment selectable.

`/prototype` on that server is a simulated mockup of the `hello.txt` prompt and approval flow, beside the same ledger. The ledger is a snapshot of the session log and is not a second history. The page does not follow later session events. Enter sends the prompt; Shift+Enter inserts a newline. A second send does nothing until the open turn decides. The scripted call is always `write` `write-hello` with arguments `{"path":"hello.txt","content":"hello\n"}` and the workspace the server was given. The typed text is only the simulated user message. The simulation uses the default policy: read, glob, grep, and skill are allowed and do not ask. **Allow once** and **Deny** decide that one call; another click does nothing. Any action other than Allow once leaves the tool unstarted. The page does not call DeepSeek, read an API key, append the session, or create `hello.txt`.

The live composer uses a separate control server; this mockup remains read-only and simulated.

`MINI_VIEW=1` serves the same page beside the interactive terminal and follows the open session. Inspect mode ignores it. The viewer reads the session log. It does not keep a second history. A reconnect continues from the last sequence it observed. Terminal input and approvals stay in the terminal.

To use the optional browser controls alongside the terminal, start the agent with:

```sh
MINI_WEB=1 npm start
```

Open the printed **Web** address (default `http://127.0.0.1:7484`; set `MINI_WEB_PORT`, including `0` for an available port). Chat sends one prompt at a time, streams the same session events, and asks for each exact write, edit, or shell call with **Allow once** or **Deny**. Enter sends; Shift+Enter inserts a newline. A turn's intermediate narration, permission decisions, and tool output are one collapsed row. Expand it for the full activity in order; long output scrolls inside the row, and collapsing returns to the one-line summary. The final answer stays visible. A pending approval stays outside the row. A failed, denied, or interrupted tool stays visible on the summary while the row is collapsed. Expanding a row and its scroll position survive later events. Trajectory shows the same log with input, model, and tool timing spans; streamed fragments are grouped into expandable rows. Hover over a timing span for its recorded times, or select it to open those details. Inputs are instants, and unfinished spans do not show an invented duration. A browser disconnect denies any pending approval, and a reconnected browser cannot approve that old request. Terminal prompts and approvals continue to work in the terminal; a second prompt is rejected while the agent is busy.

The control server binds to `127.0.0.1`, accepts control requests only from its own origin, and keeps provider credentials on the server. It is separate from the read-only `npm run view` and `MINI_VIEW=1` viewer. As with terminal approval, an allowed tool runs with your user's permissions; the workspace is not a sandbox.

## Plugins

The terminal, agent, registries, session, provider, tools, permissions, prompt contributions, skills, viewer, and web controls are Cordis plugins. `src/composition.js` supplies the default composition; each entry has a name, a plugin, and optional config. `boot()` starts the entries on Cordis fibers, waits for their dependencies, and disposes their effects on shutdown or startup failure. A plugin can register services, tools, prompt contributions, and permission policies through the injected context.

Set `MINI_CONFIG` to an explicit JSON file to customize the interactive agent. Relative config paths start at `MINI_WORKSPACE`; module paths start at the config file's directory. The file overlays the defaults by plugin name:

```json
{
  "plugins": [
    { "name": "coding", "enabled": false },
    { "name": "greeting", "module": "./greeting.mjs", "config": { "prefix": "Hello" } }
  ]
}
```

An existing name changes that entry; `enabled: false` removes it. A new name needs a local JavaScript `module` with a default Cordis plugin export, or DSH-style named `apply` and optional `inject` exports. Use `export` to select another named export explicitly. `config` replaces that entry's config rather than merging it; if omitted, an existing entry keeps its runtime config. For example, `{ "name": "coding", "config": { "tools": ["read", "glob", "grep"] } }` keeps just those coding tools. The `skill` tool is provided by the separate `skills` plugin. `required: false` allows an optional plugin fiber to be pending or fail without blocking boot; invalid config or a module that cannot be imported still fails. New entries are inserted before shared permission services so the agent drains before their effects are removed. `before` can place a new entry before a named existing entry when a different disposal order is needed. Module imports execute code, so use a config and plugins you trust. Editing a loaded plugin module still requires a process restart. Installing or uninstalling a compatible plugin through the live web Plugins panel mounts or disposes it without a restart; other profile edits take effect on the next boot.

Inspect mode ignores `MINI_CONFIG`. The standalone viewer has its own `viewer` and `session` composition and ignores `MINI_CONFIG`; set `MINI_VIEW_CONFIG` to a separate profile to customize it. Its default session is read-only, though configured plugins and replacements can run arbitrary code.

[`examples/plugins/config.json`](examples/plugins/config.json) adds a `greet` tool using [`greeting.mjs`](examples/plugins/greeting.mjs). To try it without a key, run `MINI_CONFIG=examples/plugins/config.json MINI_REPLIES=examples/plugins/replies.json npm start` from the repository and enter a prompt. The tool and its `allow` policy are separate reversible effects. A registered tool without a policy is denied; plugins can register `allow`, `ask`, or `deny` with `ctx.permissions.register(name, policy)`. The default policies are themselves supplied by the `default-tool-permissions` plugin. Replacing that plugin lets a composition define a different policy without changing the agent.

### Installing a DSH plugin package

In the live Web interface, open **Plugins**, enter an npm package name or an HTTPS GitHub repository URL (optionally followed by `#ref`), and select **Install**. Compatible plugins are written to the profile used by that server (including an explicit `MINI_CONFIG`) and mounted into the running Cordis context without a restart; **Uninstall** disposes their registrations and removes the profile row. Disabled and otherwise unmounted installed entries are listed and can also be uninstalled. Built-in plugins and a live DSH agent-loop mount are refused; changes while a turn is in progress are refused. Uninstall also refuses when another **required** mounted plugin, including a configured built-in replacement, still injects a service only that plugin provides, listing each affected plugin and service so the saved profile stays restartable; remove or disable those dependents first. Optional profile rows (`required: false`) do not block. For path-aware plugins, mini-dsh sets `config.workDir` to the absolute workspace (and resolves a relative `workDir` against that workspace) at install, boot, and live mount — so tools such as `dsh-tool-protobuf` do not fall back to `process.cwd()` when the shell cwd differs from `MINI_WORKSPACE`. An explicit absolute `workDir` is kept. Plugins may also inject the `workspace` service and call `ctx.workspace.resolve(path)`. Session records `plugin.mounted`, `plugin.unmounted`, and `plugin.failed` are best-effort: a failed append is logged and does not roll back the profile or Cordis mount. Installation can execute package code. Only install plugins you trust.

When a dependency blocks removal, the web panel offers individual uninstall actions and a preview of the affected required dependents. Confirming the preview removes them before the provider; a changed dependency list requires a new preview. Built-in dependents cannot be removed. The profile update is staged before disposal; if committing it fails, mini-dsh attempts to remount removed plugins. If restoration also fails, the error asks you to restart from the unchanged profile. External profile editors do not take the advisory lock and must not edit the file concurrently.

The running host serializes agent turn admission with plugin installation and live mount or unmount operations, including disposal and restoration. A turn or change requested while the other is in progress is refused; retry after it finishes. This coordination is local to one mini-dsh process and does not coordinate separate processes or external profile edits.

Dependency checks use the actual provider visible in each consumer's Cordis scope. With the pinned Cordis 4.0.5, a second provider for the same service in the same scope is rejected; a same-named provider in another isolated scope is independent and is not a fallback. Every declared `inject` key is required for activation, including one whose interception configuration contains `required: false`. This differs from setting `required: false` on the plugin's profile row. The check does not predict providers that might be created dynamically after disposal, so it refuses removal when an existing required consumer currently uses the provider being removed.

The check includes service providers and consumers in nested Cordis plugin fibers. It conservatively treats a nested consumer as part of its required parent plugin; Cordis does not expose a separate mini-dsh profile `required` setting for the child. This behavior uses fiber ownership and registry internals pinned to Cordis 4.0.5.

To remove an installed plugin when mini-dsh is stopped, run `npm run plugin:uninstall -- <name>` with `MINI_WORKSPACE` and, if needed, `MINI_CONFIG` set. The command starts the trusted profile in a separate Cordis context with a temporary session and checks the resulting dependency graph. Plugin startup and teardown can execute code and have side effects; use it only for trusted plugins. It refuses removal if the profile cannot boot or an enabled plugin cannot be inspected. It uses the standard composition and fake model provider, so profiles depending on a custom composition or provider may need to be managed through their running host instead. Stop all mini-dsh instances using the profile first: the offline command does not coordinate with their live graphs. It refuses a profile that changes between inspection and update. Package files are left on disk.

The offline command also supports profiles using the DSH agent loop. The loop itself cannot be uninstalled from a running web session; stop mini-dsh and use the offline command to remove it.

To remove a plugin together with its required dependents, run `npm run plugin:uninstall -- <name> --cascade`. The command previews the ordered list and requires you to type `yes` before making changes. It rechecks the profile and dependency plan after confirmation; cancelling or a failed check leaves the profile unchanged. Built-in dependents cannot be removed by the cascade.

Install a trusted npm package, local package directory, or tarball into the current workspace:

```sh
npm run plugin:install -- @example/dsh-plugin
# Or: npm run plugin:install -- ./path/to/plugin.tgz
npm start
```

The installer uses `MINI_WORKSPACE` (or the current directory) and npm, stores each installation under `<workspace>/.mini-dsh/`, and adds plugin rows to `.mini-dsh/plugins.json`. A running web-control server activates those rows live; otherwise the interactive entry loads the profile on the next start. An explicit `MINI_CONFIG` takes precedence; to combine it with installed plugins, copy the installed rows into that profile. Inspect mode and the standalone viewer do not load this profile. Paths beginning with `.` are resolved from the shell's current directory. npm installation and plugin loading can execute package code, so install only packages you trust. The installer leaves the profile unchanged on failure and rejects duplicate plugin names; remove a row from the profile (or use web **Uninstall**) to disable it.

Concurrent installers serialize updates with a SQLite advisory lock beside the profile and wait up to 30 seconds. As with the session writer lock, use a local filesystem; external editors do not participate in the lock.

The installer accepts a package exposing a plugin entry point, or a DSH bundle declaring `dsh.bundle.patch`. Bundle support covers ordered patch files that use:

- `insert` arrays with `id`, `name`, and optional `config` or boolean-literal `disabled` rows (`disabled: true` becomes profile `enabled: false`)
- id-targeted replace ops (`id` plus `config`, `name`, and/or boolean `disabled`) that rewrite a row inserted earlier **in the same install** as a whole; replacing a pre-existing profile row from another package fails explicitly with no profile write
- Live activation returns `names` as the **unique** plugin ids from that install that should mount now (`enabled: false` / `disabled: true` rows are omitted; a same-install replace does not re-list an id)
- Installation also returns `installedNames` with all inserted ids, including disabled entries; a bundle with no active entries has phase `installed` rather than `active`.

`remove`, `preset`, `group`, `isolate`, `!!js` expressions, profile layering, and version checks stay unsupported and fail explicitly without changing the profile. npm installs never pass `--force` or `--legacy-peer-deps`; an `ERESOLVE` peer conflict leaves the profile unchanged and surfaces the conflicting peer rather than treating a forced install as compatibility. Plugins still need the services and tool features supported by mini-dsh; a successful install does not guarantee a plugin can boot. For npm dependencies, install a built package whose peers resolve cleanly.

Installed tools have no automatic permission grant and are denied by default. To allow a particular tool, add a policy to `.mini-dsh/plugins.json`, for example:

```json
{ "name": "default-tool-permissions", "config": { "policies": { "my_tool": "ask" } } }
```

Add that object to the existing `plugins` array. Use `allow`, `ask`, or `deny` and restart the agent. Installed files can be removed manually after their profile rows have been removed.

### DSH tool compatibility (initial subset)

Mini-dsh can load a local, built DSH-style module that exports `apply` and `inject` and registers a tool through `ctx.tools.register()` (including tools produced by `@deepseek-ai/dsh-tools` `defineTool`). For example, if `./parity-probe.mjs` registers `parity_probe`, configure an explicit policy for it:

```json
{
  "plugins": [
    { "name": "parity-probe", "module": "./parity-probe.mjs" },
    { "name": "default-tool-permissions", "config": { "policies": { "parity_probe": "ask" } } }
  ]
}
```

Policy values are `allow`, `ask`, or `deny`; configured entries override the built-in policies. A tool without a policy is still denied. Direct tool registrations are removed with their owning plugin fiber (`ctx.effect`); a later plugin cannot replace another plugin's tool name, and dispose only removes the exact registration identity.

Supported tool fields: `name`, `description`, `parameters` (object JSON Schema), `execute`, optional `output` (`schema` + `render`), optional cooperative `timeoutMs`. DSH tools may return lossless JSON (objects or arrays) declared by a JSON Schema accepted by Ajv strict mode. Mini-dsh snapshots and validates the result, deep-freezes it for the renderer, and joins text `ContentBlock`s into the model-facing string recorded on JSONL `tool.finished`. Unsupported or asynchronous schemas are rejected at registration; argument validation remains limited. With `output`, `execute` receives `{ name, callId, signal }`. A declared `timeoutMs` aborts that signal and reports a timeout after the tool settles; it cannot forcibly stop a tool that ignores cancellation.

Accepted and ignored (not invoked; mini-dsh has no tool UI and runs tool calls sequentially): `presentCall`, `presentResult`, `isConcurrencySafe`, and `output.presentationMeta`. Real plugins such as `dsh-tool-invoice@1.0.0` that declare those helpers still load and run their text render path.

Rejected explicitly at registration: registration options (including `when`), `projectContent`, `finalizeContent`, `deferLoading`, and any other tool or output field. Rejected at run time: non-JSON results, schema mismatches, and non-text output blocks. Unknown tool names, permission denials, and failures follow the existing JSONL permission / checkpoint path.

Mini-dsh supplies a lean `agents` service and dispatches the cooperative `agent/pre-step` waterfall before each model step on its own loop, recording `agent.pre-step` and `turn/end` on the JSONL session so plugins such as `dsh-message-datetime` can inject per-turn context and read idle gaps. Listeners register with Cordis `ctx.on('agent/pre-step', ...)` (reversible with the fiber, including LivePlugins unmount) or `ctx.agents.on(...)`. Appended user messages are flattened to text and committed before the model request; reject closes the turn without a model call. Other `agent/*` hooks, `agents.create`/`resume`/`setFactory`, scoped services, `tools.presentAs` / `restrict` / `guard`, `tools/*` waterfalls, Code Mode, `deferContext`, parallel concurrency scheduling, non-text ContentBlocks as model input, and UI plugins are not implemented and fail when a plugin requires them. A module requiring an unavailable service cannot start. The installer supports only the bundle subset described above; other DSH bundle semantics are not implemented. This is not general DSH plugin compatibility.

### DSH agent services and hooks

The `agents` Cordis service satisfies plugins that inject `agents`. It exposes a single mini-dsh handle (`id: mini-dsh`) whose `session.snapshotEvents()` projects JSONL `turn/end` events for idle-gap readers. A recorded `turn/end` means that turn ended (completed, rejected at pre-step, or shut down), not that it succeeded. Supported hook: `agent/pre-step` only (waterfall). Unsupported semantics throw: other hook names via `agents.on`, factory APIs, and pre-step decisions that replace or shorten the baseline message list. Pre-step baselines are presented with a DSH-shaped `source` so unmodified readers such as `dsh-message-datetime` do not crash on plain history messages. This adapter does not replace the mini-dsh loop with the DSH loop; see the agent-loop bridge below for that path.

### DSH agent-loop bridge

Installing `@deepseek-ai/dsh-agent-loop@0.1.0-rc.6` into the interactive profile switches the mini-dsh agent to that official loop after restart. Its DSH services live in a separate Cordis context, avoiding the conflicting `agent` accessor. The bridge sends model calls through mini-dsh's provider and routes tool calls through its permission and checkpoint services. Terminal and Web use the same bridge.

Mini-dsh's JSONL log remains the source of truth for conversation history and recovery. The DSH driver's own session is in memory and is recreated on restart; DSH session events, its model configuration, other scoped DSH services and hooks, and custom agent-loop config are not bridged. Tool calls run sequentially. Only version `0.1.0-rc.6` is supported; installing another loop version fails at startup. Do not combine this loop with a replacement for mini-dsh's `agent` plugin.

To test the unmodified `@deepseek-ai/dsh-tool-workspace-dependencies` plugin against a temporary fixture payload, set `DSH_TEST_WORKSPACE_DEPENDENCIES` to its absolute built module path and run `node --test test/dsh-workspace-dependencies.test.js`. The module's imports must already resolve. The test uses a fake provider and placeholder files, not a real Python runtime.

The interactive entry calls the `terminal` service's `run({ workspace, sessionPath, viewerUrl, webUrl })` method, and forwards approval requests to `approve(detail, signal)`. A profile can replace the `terminal` plugin with another implementation of that interface. Only an approval result of `true` grants the call; an absent approval method denies it. Browser turns use their own approval callback.

## Skills

Mini-dsh scans the same default filesystem roots as dsh, in priority order: `<project>/.dsh/skills`, `<project>/.agents/skills`, `~/.dsh/skills`, and `~/.agents/skills`. The project is the nearest ancestor of the workspace containing `.git`, or the workspace itself when none exists. `DSH_HOME` replaces `~/.dsh`, and `DSH_AGENTS_HOME` replaces `~/.agents`. The `.system` directory under the user DSH skills root is skipped. An optional `DSH_BUNDLED_SKILL_DIR` is scanned last. Embedders may pass `skillOptions.customSkillDirs` to `boot()`; these directories are scanned after the project roots and before the user roots.

For example, set `DSH_BUNDLED_SKILL_DIR="$HOME/repos/hsliuustc0106-skills/skills"` to discover the skills in that checkout. Each root accepts direct `<name>/SKILL.md` bundles or `<name>.md` files with YAML frontmatter containing a kebab-case `name` and a `description`. For duplicate names, the first valid skill wins. Discovery follows symlinks, reports invalid entries or unreadable roots, and retries on the next request.

The model receives skill names and descriptions and can call the read-only `skill` tool to load the full instructions and their resource directory. The catalog is rescanned for each model request. To invoke a skill directly, include a whitespace-bounded `/name` in your message, for example `/review check this change`. Multiple names load in first-seen order; repeated names load once. File paths and unknown names stay ordinary text. `user-invocable: false` disables direct invocation. `disable-model-invocation: true` hides the skill from the model's catalog and tool, but still permits direct invocation unless `user-invocable` is also false. Loaded instructions are stored with the user message and remain in session history after a restart, even if the skill file changes.

## Composition and boot

`src/composition.js` is the coding-agent composition. `boot()` in `src/boot.js` is the shared entry used by the terminal and by tests. It checks the workspace, starts each plugin on its own Cordis fiber, waits until required plugins are active, and disposes every fiber it started when startup fails. A failed or missing plugin is reported by name. Disposing one plugin removes only that plugin's registrations.

Prompt plugins contribute ordered instructions through `ctx.prompt.contribute()`. The coding plugin adds guidance for its search and file tools while the prompt service is available. A custom composition passed to `boot()` can replace the `instructions` plugin or add its own contributions. The default prompt encourages grouping independent tool calls to reduce model round trips; the agent still executes those calls sequentially and checks permissions for each call.

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

1. `src/composition.js` selects default plugins, and `src/plugin-config.js` applies the optional named overlay. `src/main.js` boots that composition; `src/terminal.js` supplies the interactive input and approval plugin. Shutdown disposes consumers first, so a turn can record a known outcome before the session releases its writer lock.
2. `src/services.js` defines the workspace, the model provider registry, the tool registry, the checkpoint policy, and the session. The agent builds model messages from message events.
3. `src/coding.js` registers read, write, edit, shell, and the glob and grep tools from `src/search.js` with `ctx.effect`. Relative paths and the shell working directory come from the boot workspace. Disposing that plugin removes its tools.
4. `src/prompt.js` collects ordered instruction and runtime-context contributions for the life of the plugin that added them. `src/skills.js` contributes a current catalog and the `skill` loader. Context describes the workspace and the permission policy. It does not enforce them.
5. `src/permissions.js` defines the permission registry and a default policy plugin: read, glob, grep, and skill are allowed; each write, edit, or shell call asks; unknown tools are denied. Only an answer of `true` is a grant. The terminal supplies that answer once per call. Approval is not a sandbox.
6. `src/provider.js` registers one provider. `MINI_REPLIES` registers the fake provider. A credential with no replies registers DeepSeek. Each model call is prepared once. The prepared body is the request that will be sent. DeepSeek's body is the chat-completions JSON, without the API key. `dispatch()` yields that call's chunks once.
7. `src/agent.js` runs one turn at a time. It records that body before dispatch, commits each observed chunk before reading the next, and writes the assistant message from those committed deltas only after a complete finish. It then checkpoints `tool.started` before each tool body and records the observed result after. A second turn is rejected as busy. Shutdown stops new turns, cancels a pending approval, drains a tool body that already started, and does not invent a result or reply text that was never observed.
8. The tests exercise plugin configuration, disposal, replay, recovery, the agent, both web views, search, skills, and the DeepSeek request body with a mocked HTTP call. Run `npm test`. `npm run replay` runs the terminal replay on its own. No API key is required. `npm run smoke` is the live check.
9. `src/trajectory.js` projects session events into turns, conversation cards, timing spans, and observed stream fragments. The projection is a function of that log. `src/viewer.js` serves it on `127.0.0.1`. The server is a `ctx.effect` registration, so unloading the plugin closes it. `npm run view` opens the log read-only. `MINI_VIEW=1` follows a live terminal session from the same session service. Reconnect with the last sequence you observed. `src/prototype.js` is the `/prototype` page: the same projection, plus a simulated turn that is not written back.
10. `src/web-control.js` is an optional Cordis plugin for the live agent. Browser turns use a per-turn approval callback, so terminal turns keep their own approval prompt. Each browser approval belongs to one live connection and one call; the session remains the only history.

`fixtures/write-hello/` is the recorded fake-model task: prepared replies, the session log, and `hello.txt`. The replay drives `src/main.js` in an explicit workspace and checks the session events and that file. Those replies are streamed into the session as deltas. The trajectory viewer projects that same log, including an interrupted tool with no recorded result. Live DeepSeek is the interactive provider, `npm run smoke`, and the optional prompt benchmark. This version has no sandbox, compaction, or full DeepSeek Harness session compatibility. Pull-request CI runs the keyless suite.
