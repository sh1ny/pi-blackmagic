import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const nu = Bun.which("nu");
const launcher = fileURLToPath(new URL("../start.nu", import.meta.url));
const entrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));

(nu ? test : test.skip)(
  "Nushell launcher uses isolated fullscreen defaults, forwards arguments, and preserves exit codes",
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi settings launcher-"));
    const recorded = join(temporary, "launch.json");
    const stub = join(temporary, "fake-pi.cjs");
    const executable = join(
      temporary,
      process.platform === "win32" ? "pi.cmd" : "pi",
    );
    const originalAgent = join(temporary, "existing-agent");
    const created: string[] = [];
    try {
      await writeFile(
        stub,
        `require('node:fs').writeFileSync(process.env.PI_LAUNCH_RECORD, JSON.stringify({args:process.argv.slice(2),agent:process.env.PI_CODING_AGENT_DIR})); process.exit(Number(process.env.PI_LAUNCH_EXIT || 0));`,
      );
      await writeFile(
        executable,
        process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "${stub}" %*\r\nexit /b %errorlevel%\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`,
      );
      if (process.platform !== "win32") await chmod(executable, 0o700);
      const env = {
        ...process.env,
        PATH: `${temporary}${delimiter}${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: originalAgent,
        PI_LAUNCH_RECORD: recorded,
      };
      const isolated = Bun.spawnSync(
        [nu as string, launcher, "--", "--verbose"],
        { cwd: temporary, env },
      );
      if (isolated.exitCode !== 0) throw new Error(isolated.stderr.toString());
      expect(isolated.exitCode).toBe(0);
      const first = JSON.parse(await readFile(recorded, "utf8")) as {
        args: string[];
        agent: string;
      };
      created.push(first.agent);
      expect(first.agent).not.toBe(originalAgent);
      expect(first.args).toEqual([
        "--offline",
        "--no-session",
        "--no-approve",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-tools",
        "--extension",
        entrypoint,
        "--tui-mode",
        "fullscreen",
        "--verbose",
      ]);
      expect(isolated.stdout.toString()).toContain(
        "Temporary user configuration:",
      );
      const live = Bun.spawnSync(
        [nu as string, launcher, "--live", "--mode", "regular"],
        { cwd: temporary, env: { ...env, PI_LAUNCH_EXIT: "7" } },
      );
      expect(live.exitCode).toBe(7);
      const second = JSON.parse(await readFile(recorded, "utf8")) as {
        args: string[];
        agent: string;
      };
      expect(second.agent).toBe(originalAgent);
      expect(second.args.slice(-2)).toEqual(["--tui-mode", "regular"]);
      expect(live.stdout.toString()).toContain("edits will change those files");
      await rm(recorded);
      const invalid = Bun.spawnSync(
        [nu as string, launcher, "--mode", "invalid"],
        { cwd: temporary, env },
      );
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.stderr.toString()).toContain(
        "--mode must be fullscreen or regular",
      );
      expect(await Bun.file(recorded).exists()).toBe(false);
    } finally {
      for (const directory of created)
        await rm(directory, { recursive: true, force: true });
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
