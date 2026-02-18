#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";

const pnpmBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function printHelp() {
  process.stdout.write(
    [
      "Usage: pnpm dev -- [--remote] [--opencode] [--opencode-directory <path>]",
      "",
      "Flags:",
      "  --remote                      Bind server and web to 0.0.0.0",
      "  --opencode                    Enable OpenCode mode and disable Codex mode",
      "  --opencode-directory <path>   Set OpenCode directory on startup",
      "  --help                        Show this help message"
    ].join("\n")
  );
  process.stdout.write("\n");
}

function parseArgs(argv) {
  const result = {
    remote: false,
    opencode: false,
    opencodeDirectory: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--remote") {
      result.remote = true;
      continue;
    }
    if (arg === "--opencode") {
      result.opencode = true;
      continue;
    }
    if (arg === "--opencode-directory") {
      const nextArg = argv[index + 1];
      if (!nextArg || nextArg.startsWith("--")) {
        process.stderr.write("Missing value for --opencode-directory\n");
        process.exit(1);
      }
      result.opencodeDirectory = nextArg;
      index += 1;
      continue;
    }

    process.stderr.write(`Unknown argument: ${arg}\n`);
    process.exit(1);
  }

  return result;
}

function runBuild(filter) {
  const result = spawnSync(
    pnpmBinary,
    ["--filter", filter, "build"],
    {
      stdio: "inherit",
      env: process.env
    }
  );

  if (typeof result.status === "number") {
    return result.status;
  }

  if (result.error) {
    process.stderr.write(`${String(result.error)}\n`);
  }
  return 1;
}

const args = parseArgs(process.argv.slice(2));

const buildFilters = ["@farfield/protocol", "@farfield/api", "@farfield/opencode-api"];
for (const filter of buildFilters) {
  const status = runBuild(filter);
  if (status !== 0) {
    process.exit(status);
  }
}

const devScript = args.remote ? "dev:remote" : "dev";
const serverArgs = [];
if (args.opencode) {
  serverArgs.push("--opencode");
}
if (args.opencodeDirectory.trim().length > 0) {
  serverArgs.push("--opencode-directory", args.opencodeDirectory);
}

const serverCommand = ["--filter", "@farfield/server", devScript];
if (serverArgs.length > 0) {
  serverCommand.push("--", ...serverArgs);
}

const serverProcess = spawn(pnpmBinary, serverCommand, {
  stdio: "inherit",
  env: process.env
});

const webProcess = spawn(
  pnpmBinary,
  ["--filter", "@farfield/web", devScript],
  {
    stdio: "inherit",
    env: process.env
  }
);

const childProcesses = [serverProcess, webProcess];
let terminating = false;
let firstExit = {
  code: null,
  signal: null
};

const stopChildren = (signal) => {
  if (terminating) {
    return;
  }
  terminating = true;
  for (const child of childProcesses) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
};

process.on("SIGINT", () => stopChildren("SIGINT"));
process.on("SIGTERM", () => stopChildren("SIGTERM"));

let remainingChildren = childProcesses.length;
for (const child of childProcesses) {
  child.on("exit", (code, signal) => {
    if (firstExit.code === null && firstExit.signal === null) {
      firstExit = { code, signal };
    }

    remainingChildren -= 1;
    if (!terminating && remainingChildren > 0) {
      stopChildren("SIGTERM");
    }

    if (remainingChildren === 0) {
      if (firstExit.signal) {
        process.kill(process.pid, firstExit.signal);
        return;
      }
      process.exit(firstExit.code ?? 0);
    }
  });
}
