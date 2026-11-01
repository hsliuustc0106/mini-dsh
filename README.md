# Mini DeepSeek Harness

A small coding agent for studying [Cordis](https://github.com/cordiverse/cordis) and the [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness). It uses real Cordis services, dependency injection, and reversible effects. It is an independent teaching project, not a DeepSeek Harness profile or a compatible session implementation.

## Run

Requires Node.js 20 or later and a DeepSeek API key.

```sh
npm install
export DEEPSEEK_API_KEY='your-key'
npm start
```

Run from the directory you want the agent to work in, for example `cd my-project && node /path/to/mini-deepseek-harness/src/main.js`. The agent can read, overwrite, edit, and execute commands with your user account's permissions; use a disposable working directory when experimenting. Type `/quit` to exit. The terminal waits for a complete model response before printing it.

`DEEPSEEK_MODEL` defaults to `deepseek-chat`; `DEEPSEEK_BASE_URL` defaults to `https://api.deepseek.com`. `MINI_SESSION` selects the JSONL file (default `.mini-session.jsonl` in the working directory). The log contains conversation and tool output, which may include sensitive data. Keep it private. The system prompt is defined in `src/agent.js`; changing it changes the prompt for resumed sessions.

## Study the core

1. `src/main.js` mounts consumers before providers. Cordis activates them when their required services appear.
2. `src/services.js` defines the model, tool registry, and append-only session services. The agent constructs model messages from the session log.
3. `src/coding.js` registers tools with `ctx.effect`. Disposing that plugin removes its tools.
4. `src/agent.js` depends on the three services and implements the model → tools → model loop. Cordis deactivates it if a required service disappears and reactivates it when the service returns.
5. `test/core.test.js` exercises disposal, dependency activation, tool use, and session replay with a deterministic fake model. Run `npm test`.

The session records each assistant tool call before executing it and each result afterwards. If the process stops during a call, the next launch refuses the incomplete session: inspect the working directory and repair or move the log before continuing. It cannot determine whether an interrupted command took effect. Model and tool failures are surfaced; the program stops after a model or log failure. This teaching version has no sandbox, concurrent session protection, compaction, streaming, or full DeepSeek Harness session compatibility.
