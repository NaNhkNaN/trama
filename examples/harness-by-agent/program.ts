// A harness that is somebody else's — and a program itself.
//
// examples/coding-harness is a harness written as a program: its loop, its
// tools and its words are the program's. This is the other choice. The work
// is handed, whole, to an agent from outside — a coding agent the user has
// installed and is logged in to, named in the configuration ("agents" in
// ~/.trama/config.json) and spoken with by the Agent Client Protocol. It is
// a black box: a task in; out, what it said and how its turn ended.
//
// What the two share is where they sit. Run with a `task`, each works where
// its run works — the run's workspace, where it has one; else its own
// project. So this can be pointed at a codebase (`trama run`, `runProgram`
// with a `workspaceDir`), judged by a checker of what it left there, held
// against another harness on the same work, or named as the harness of a
// writer (examples/write-by-harness: "harness" in that project's arguments).
//
// What the agent does is its own, under the user's login for it: every
// permission it asks is granted for the once, and what it says it used is
// its own account — recorded with the run, and not under the run's budget.
import { ctx, tools, workspace } from "@trama-dev/runtime";

const { task = ctx.input.prompt, agent, model, system, seconds } = ctx.input.args as {
  task?: string; agent: string; model?: string; system?: string; seconds?: number;
};
// The run's workspace, where it has one; else the project this is the program of. (A run that has none is told so
// when it asks for it — and only that is taken for having none.)
const there = await workspace.shell("true").then(() => workspace, (err: unknown) => {
  if (/This run has no workspace/.test(String((err as Error)?.message))) return tools;
  throw err;
});

const done = await there.agent(task, {
  agent,
  ...(model !== undefined && { model }),
  ...(system !== undefined && { system }),
  ...(seconds !== undefined && { timeout: seconds * 1000 }),
});
// A call that did not go through — the agent not installed, not logged in, too slow, refusing — is a run that failed.
// But a turn that ended at a limit of the agent's own is the run's result, with `ok` false — as a harness that runs
// out of turns ends its run: the work may have been done, and whoever judges it looks at what was left.
const atALimit = done.stopReason === "max_tokens" || done.stopReason === "max_turn_requests";
if (done.failure && !(done.failure.kind === "failed" && atALimit)) throw new Error(`The agent did not do the work (${done.failure.kind}): ${done.failure.message}`);

await ctx.done({
  ...(done.messages.length > 0 && { summary: done.messages.at(-1) }),
  ok: done.ok,
  ...(done.stopReason !== undefined && { stopReason: done.stopReason }),
  ...(done.session !== undefined && { session: done.session }),
  ...(done.usage !== undefined && { usage: done.usage }),
});
