# DSH plugin acceptance samples

Partial results for [#97](https://github.com/hsliuustc0106/mini-dsh/issues/97), tested against mini-dsh main `f08a80d` on 2026-11-05. Package names and versions are pinned to the [awesome-dsh-plugin catalog](https://awesome-dsh-plugin.com/plugins.json) snapshot marked 2026-11-04. `dsh-TUI` refers to the catalog's case-matching `@deepseek-harness-tui/dsh-tui` entry.

Each package was installed in a separate temporary workspace using `installPlugin`, then, if installation succeeded, booted from the saved profile with the fake provider. The tests used an empty temporary home and no model credentials. **Booted** would mean only that the profile activated; it would not establish that a plugin's UI or tools work. No package below booted successfully. Failures at installation were not booted.

| Sample | Package and version | Installation | Runtime observation |
| --- | --- | --- | --- |
| dsh-market | `dshmarket@1.73.11` | Succeeded; inserted `dsh-market` | Import failed: `@deepseek-ai/schemastery` was not found by the installed package. |
| dsh-TUI | `@deepseek-harness-tui/dsh-tui@0.18.0` | Rejected | Bundle's `!!js` expression uses `ctx.baseUrl` and other unsupported operations. |
| DSH-better-sidebar | `dsh-better-sidebar@0.30.0` | Rejected | Declares unsupported DSH client UI and locale peers; see [#66](https://github.com/hsliuustc0106/mini-dsh/issues/66). |
| modlens | `@liustack/modlens@3.27.2` | Succeeded; inserted `modlens` | Pending: missing `attachments` and `llm` services. |
| dsh-context | `dsh-context@0.81.2` | Rejected | Declares unsupported DSH client UI primitives peer; see [#66](https://github.com/hsliuustc0106/mini-dsh/issues/66). |
| dsh-agent-teams | `@nanmicoder/dsh-agent-teams@0.1.28` | Rejected | Declares unsupported DSH client UI, connection and store peers; see [#66](https://github.com/hsliuustc0106/mini-dsh/issues/66) and [#69](https://github.com/hsliuustc0106/mini-dsh/issues/69). |
| dsh-vision-router | `dsh-vision-router@3.1.2` | Rejected | Bundle's `!!js` expression reads `ctx.visionRouterWebConnectionReady.trustedHosts`, which is unsupported. |
| dsh-vision-toolkit | `@anionex/dsh-vision-toolkit@0.1.48` | Rejected | Declares unsupported DSH client UI and locale peers; see [#66](https://github.com/hsliuustc0106/mini-dsh/issues/66). |

The `dsh-web` and `dsh-pocket` heatmap entries are not assigned here: the catalog did not have an exact `dsh-web` entry and had multiple `dsh-pocket` entries. Their identities were not confirmed, so these results do not complete the Top 10 matrix. Future runs should record the exact package and version as well as the mini-dsh commit; upstream catalog entries and package behavior can change.

These observations do not establish general DSH compatibility or cover real-model execution. In particular, a successful installation is not evidence of runtime activation. The tests do not change mini-dsh's agent loop, session log or permission model.

Follow-up investigations: [market activation #99](https://github.com/hsliuustc0106/mini-dsh/issues/99), [context compatibility #100](https://github.com/hsliuustc0106/mini-dsh/issues/100), and [vision compatibility #101](https://github.com/hsliuustc0106/mini-dsh/issues/101).
