import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyPostToolUseEvent,
  applyStopEvent,
  applyUserPromptEvent,
  buildBugfixPolicyContext,
  classifyBashCommand,
  detectBugfixIntent,
  extractPatchedFiles,
} from "../codex-hooks/bugfix-regression-guard";

const repoRoot = "/tmp/nba-predict";

function createOptions() {
  return {
    repoRootResolver: () => repoRoot,
    stateRoot: mkdtempSync(path.join(tmpdir(), "bugfix-regression-guard-")),
  };
}

describe("bugfix regression guard hook", () => {
  it("treats concrete broken-behavior prompts as bug fixes and ignores meta policy prompts", () => {
    expect(
      detectBugfixIntent("this won't even load, fix the loading bug")
    ).toBe(true);
    expect(
      detectBugfixIntent(
        "Add a hook rule that enforces regression test coverage after any bug fix"
      )
    ).toBe(false);
  });

  it("extracts all patched files from apply_patch input", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: apps/web/src/App.tsx",
      "@@",
      "-old",
      "+new",
      "*** Add File: apps/web/src/AppRoutes.test.tsx",
      "+test",
      "*** End Patch",
    ].join("\n");

    expect(extractPatchedFiles(patch)).toEqual([
      "apps/web/src/App.tsx",
      "apps/web/src/AppRoutes.test.tsx",
    ]);
  });

  it("classifies changed-surface tests separately from the repo verify command", () => {
    expect(
      classifyBashCommand(
        "pnpm --filter @signal-console/web exec vitest run src/app/AppRoutes.test.tsx --config ../../vitest.config.ts"
      )
    ).toEqual({ isTestCommand: true, isVerifyCommand: false });
    expect(classifyBashCommand("pnpm verify")).toEqual({
      isTestCommand: false,
      isVerifyCommand: true,
    });
  });

  it("injects the bug-fix policy on real bug-fix prompts", () => {
    const options = createOptions();
    const output = applyUserPromptEvent(
      {
        cwd: repoRoot,
        prompt: "the app is broken and won't load, fix it",
        session_id: "session-1",
        turn_id: "turn-1",
      },
      options
    );

    expect(output).toEqual({
      hookSpecificOutput: {
        additionalContext: buildBugfixPolicyContext(),
        hookEventName: "UserPromptSubmit",
      },
    });
  });

  it("blocks bug-fix turns that edit source code without broader regression coverage or verification", () => {
    const options = createOptions();
    applyUserPromptEvent(
      {
        cwd: repoRoot,
        prompt: "the dashboard is broken and not loading",
        session_id: "session-2",
        turn_id: "turn-2",
      },
      options
    );

    applyPostToolUseEvent(
      {
        cwd: repoRoot,
        session_id: "session-2",
        tool_input: {
          command: [
            "*** Begin Patch",
            "*** Update File: apps/web/src/features/desk/TraderDeskPage.tsx",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
          ].join("\n"),
        },
        tool_name: "apply_patch",
        turn_id: "turn-2",
      },
      options
    );

    const output = applyStopEvent(
      {
        cwd: repoRoot,
        session_id: "session-2",
        stop_hook_active: false,
        turn_id: "turn-2",
      },
      options
    );

    expect(output).toEqual({
      decision: "block",
      reason:
        "Regression coverage gate: add or update a behavior-level regression test for the broken behavior; run at least one changed-surface test command; run `pnpm verify` Remember: the regression test must protect the observable contract or feature behavior, not just the edited helper.",
    });
  });

  it("allows bug-fix turns to stop once test coverage, a changed-surface test, and verify were all attempted", () => {
    const options = createOptions();
    applyUserPromptEvent(
      {
        cwd: repoRoot,
        prompt: "the api route is broken and returning the wrong state",
        session_id: "session-3",
        turn_id: "turn-3",
      },
      options
    );

    applyPostToolUseEvent(
      {
        cwd: repoRoot,
        session_id: "session-3",
        tool_input: {
          command: [
            "*** Begin Patch",
            "*** Update File: apps/api/src/routes/research.ts",
            "@@",
            "-old",
            "+new",
            "*** Update File: apps/api/src/__tests__/routes.test.ts",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
          ].join("\n"),
        },
        tool_name: "apply_patch",
        turn_id: "turn-3",
      },
      options
    );

    applyPostToolUseEvent(
      {
        cwd: repoRoot,
        session_id: "session-3",
        tool_input: {
          command:
            "pnpm --filter @signal-console/api exec vitest run src/__tests__/routes.test.ts --config ../../vitest.config.ts",
        },
        tool_name: "Bash",
        tool_response: { exit_code: 0 },
        turn_id: "turn-3",
      },
      options
    );

    applyPostToolUseEvent(
      {
        cwd: repoRoot,
        session_id: "session-3",
        tool_input: {
          command: "pnpm verify",
        },
        tool_name: "Bash",
        tool_response: { exit_code: 1 },
        turn_id: "turn-3",
      },
      options
    );

    const output = applyStopEvent(
      {
        cwd: repoRoot,
        session_id: "session-3",
        stop_hook_active: false,
        turn_id: "turn-3",
      },
      options
    );

    expect(output).toBeNull();
  });

  it("ships the repo-local hook wiring for prompt, post-tool, and stop events", () => {
    const hooksPath = new URL("../../../../.codex/hooks.json", import.meta.url);
    const config = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ command: string }> }>
      >;
    };

    expect(config.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toContain(
      'bugfix-regression-guard.ts" user-prompt-submit'
    );
    expect(config.hooks.PostToolUse.map((entry) => entry.matcher)).toEqual([
      "^Bash$",
      "^(apply_patch|Edit|Write)$",
    ]);
    expect(config.hooks.Stop[0]?.hooks[0]?.command).toContain(
      'bugfix-regression-guard.ts" stop'
    );
  });
});
