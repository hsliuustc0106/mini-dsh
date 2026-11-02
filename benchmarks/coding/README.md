# Coding prompt benchmark

This benchmark compares the prompt before PR #27 with the current prompt on the same mini-dsh code, model, tools, and tasks. It runs four isolated coding tasks: a query-parser bug fix, a range-merging implementation, a cart API extension, and a configuration-merge fix. Each variant receives a fresh copy of each fixture. Order alternates across task and repetition. The previous variant replaces the base instruction and omits the coding plugin's static order-10 guidance; other prompt contributions remain the same.

Each answer is graded with at least four independent behavioral checks, including edge cases. A successful run must complete, change its assigned file, and pass all checks. Performance averages in `summary.json` include only pairs where both variants succeeded. Results also include all attempts and individual failures so incomplete or incorrect answers are visible. Latency covers the complete agent turn, not setup or grading, and model calls count actual HTTP request attempts. Each session is capped at 20 requests and 120 seconds by default.

The tasks allow reads and searches within the fixture and edits to the named source file; shell and skills are unavailable, and no other files can be edited. Quality checks run in the host process, while each generated solution runs in its own Docker container with no network, a read-only filesystem, an unprivileged user, and resource limits. The container receives copies of the solution, candidate worker, and the worker's JavaScript compartment dependencies; the API key, workspace, and host processes are not mounted. Inside the container, an SES compartment keeps candidate code away from the worker's process and protocol. It supplies ordinary JavaScript globals, `URL`, `URLSearchParams`, a quiet `console`, and those two exports from `node:url`; other Node APIs and modules are unavailable. The task prompts describe these limits. Session logs contain the tasks, responses, tool output, and request bodies, but not the API authorization header.

Run locally with Node 22, the project dependencies, and a working local Docker daemon. The benchmark uses `node:22-alpine` and checks Docker before making model calls; it fails if isolation is unavailable:

```sh
export DEEPSEEK_API_KEY_FILE=/path/to/key
npm run benchmark:prompts -- --repeats 3
```

The default is one repetition per task and prompt. `--repeats`, `--max-calls`, and `--timeout-ms` set the corresponding limits. `--output PATH` creates a new results directory at that path; without it, the benchmark creates one in the system temporary directory. Results contain a copy of the benchmark source, a JSON summary, each model's final files, and session logs. Live calls incur API charges. Set `DEEPSEEK_MODEL` or `DEEPSEEK_BASE_URL` to use a compatible alternative.

`npm test` includes keyless checks of the grader, prompt comparison, permissions, and measurement logic. Locally, those tests use a process for their own trusted fixtures; set `BENCHMARK_TEST_DOCKER=1` to run them in Docker and verify isolation. Pull-request CI sets that variable and checks the container against a dummy host secret, files, processes, and a local network service. The separate `prompt benchmark` GitHub Actions workflow runs the live comparison on pushes to main and on manual dispatch when the `DEEPSEEK_API_KEY` repository secret is configured; otherwise it skips. It shows quality failures in the job summary and uploads the results for 14 days. Live quality and latency are reported rather than used as a pass/fail threshold because one run is noisy; request or grader errors fail the workflow. Pull-request CI never exposes the key or calls the live API.

These four short tasks are a pilot, not a representative coding benchmark. They do not let the agent run tests during its turn. Provider load, response length, caching, and network conditions also affect latency.
