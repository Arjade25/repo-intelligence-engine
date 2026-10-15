# The explaining agent (experimental)

[← RIE Check README](../README.md)

**Explaining findings (`explain: true`, experimental).** The check alone decides the outcome; the agent only explains. It is experimental because only its facts are checked: its prose can overstate, nobody has yet read its 188 posted explanations by hand, and its largest findings can pass the spend cap and fall back (below). The Claude Agent SDK it runs on is an optional peer dependency, because its platform binary is about 250 MB: the Action installs it only when `explain` is on, and `rie check --explain` from the CLI needs `npm install @anthropic-ai/claude-agent-sdk` (without it, the check reports its findings unexplained). For each fail or warn finding, one Claude Agent SDK session gets the event, the facts the check proved and the PR's diff. It queries the PR's index through the rie MCP server (read-only tools; it can Read only the finding's and the diff's files), within caps on tool calls (10), spend and time. Its answer has three parts: facts (each loop, hop by hop), an explanation, and suggestions. A verifier checks every hop against the graph with no model: the import exists at that line, with that statement, survives compilation, and was or wasn't added by the PR as claimed. A rejected draft gets one retry with the verifier's reasons. If that fails too, the comment shows only the check's own findings, with none of the agent's text. Otherwise the comment adds "Explanation (verified facts)" and "Suggestions (not verified)" under the check's loops. The agent's text is escaped before posting: no HTML and no @-mentions. Over 192 sessions on real element-web and directus findings, 98% were posted, none with a hop the compiled output doesn't back, at a median $0.09 and 19 s each. A PR's first explanation costs $0.12 for a 1-loop finding and about $0.65 for 10 or more loops, and the largest findings can pass the $0.50 cap and fall back (see [Agent evaluation](#agent-evaluation-192-sessions-0-unsupported-claims-posted)). Only the facts are verified: the prose can still overstate (one run said a fixture import would fail at load time, though the imported name is only read inside a function).

## Agent evaluation: 192 sessions, 0 unsupported claims posted

`npm run agent-eval` runs the investigation agent (`explain()`, as the Action runs it) on every fail and warn finding `rie check` made in the history replay: 21 element-web commits and 23 directus commits. Each commit and its parent are checked out in temporary worktrees and indexed fresh. There are also 20 trap tasks, 10 per repo. Each takes one of those findings that has a loop of 3 or more files and adds an `import type` on the PR side, from the loop's second file back to its first. If counted, it would make a 2-file loop. It is erased at compile time, so citing it is wrong. A trap is used only if it leaves `rie check`'s events unchanged and the oracle drops it; all 20 qualified. The seeded line is in the diff the agent reads. That makes 64 findings × 3 runs = 192 sessions, run 2026-10-13 on a Claude Code subscription with the Action's defaults: `claude-opus-5-5`, at most 10 tool calls, $0.50 per finding. Nothing is scored by a model:

- **Unsupported claims** re-check every hop of every posted finding against the emit oracle, the compiled output, not the RIE index the verifier used. A blind spot shared by RIE and its verifier would show here.
- **Usefulness** checks whether the explanation names both files of an import the PR added, and a file that joined the cycle (by file name).
- **Traps** check whether any draft cited the seeded import.

| Set | Sessions | Posted (verified) | Fell back | First draft rejected | Unsupported posted | Names added import | Names joined file | Trap cited | Cost total | Median cost | Median time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| element-web · real | 63 | 63 (100%) | 0 | 0 | **0** | 63/63 | 57/57 | – | $6.44 | $0.067 | 17 s |
| element-web · trap | 30 | 30 (100%) | 0 | 0 | **0** | 30/30 | 30/30 | 0/30 | $2.88 | $0.067 | 19 s |
| directus · real | 69 | 66 (96%) | 3 | 1 | **0** | 66/66 | 63/63 | – | $10.88 | $0.096 | 19 s |
| directus · trap | 30 | 29 (97%) | 1 | 0 | **0** | 29/29 | 29/29 | 0/30 | $4.60 | $0.104 | 27 s |
| **All** | **192** | **188 (98%)** | **4** | **1** | **0** | 188/188 | 179/179 | 0/60 | **$24.81** | $0.093 | 19 s |

**What held.** No posted finding had a hop the compiled output doesn't back, in 188 posted findings: 516 loops, 3,266 hops. No trap was cited, let alone posted. The one rejected first draft was a copying slip: on the 15th hop of a long directus loop, `server.ts -> create-admin.ts`, the draft said the PR didn't add the import, though it had. The verifier named the hop, and the retry in the same session fixed it. The bad draft never reached a comment.

**What didn't.** All 4 fallbacks are the spend cap on the two largest findings: `6de6ec7944` (18 loops) and `fc9ca4f00e` (54 loops, the largest in the set). The agent has to write every hop back as structured output, and the first run also writes the large prompt to the cache. One turn went past the $0.50 cap, to $0.96–1.32, before the SDK stopped it. The cap is checked between turns, not within one. Each fallback still showed `rie check`'s own facts. Later runs of the same finding, with the prompt cached, fit under the cap.

**Cost depends on loops and on the cache.** Runs 2 and 3 of a finding came a few minutes after run 1 and read the prompt from cache. A PR's first explanation pays run 1's price:

| Loops in the finding | Sessions | Mean cost, run 1 | Mean cost, runs 2–3 |
|---|---|---|---|
| 1 | 93 | $0.124 | $0.042 |
| 2–3 | 45 | $0.205 | $0.069 |
| 4–9 | 33 | $0.265 | $0.117 |
| 10–54 | 21 | $0.647 | $0.229 |

**Limits.**
- **The agent didn't explore.** It made a tool call in 1 session of 192. It explains from the facts `rie check` hands it, and it was never tempted to build its own loop, so the traps tested whether a planted wrong import gets copied, not its judgement.
- **The usefulness checks are name matches.** They can't tell whether the prose is right. One fixture run claimed an import would fail at load time when the name is only read inside a function. No one read the 188 explanations here, and that manual read is still to do.
- **The runs share a model and prompt, so they aren't independent.** Three runs of one finding mostly measure the model's variation.
- **The run hit the subscription's session limit once.** Two sessions failed with "session limit" and were rerun after it reset; only the rerun results are kept.

Results are in `benchmarks/results/agent-eval/`: `full.jsonl` (one record per session) and `pilot.jsonl` (6 sessions run first). Summarize them with `npm run agent-eval -- --summarize=<file>`.
