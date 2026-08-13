import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * A GUI-launched Stream Deck inherits launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so a
 * bare `code` fails to spawn even though it resolves fine in a terminal. Search the usual install
 * locations too before giving up.
 */
const extraSearchDirs = (): string[] => {
  const home = homedir();
  if (process.platform === "darwin")
    return [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      join(home, ".local/bin"),
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
      join(home, "Applications/Visual Studio Code.app/Contents/Resources/app/bin")
    ];
  if (process.platform === "win32") return [];
  return ["/usr/local/bin", "/snap/bin", join(home, ".local/bin")];
};

const isExecutable = async (candidate: string): Promise<boolean> =>
  access(candidate, constants.X_OK).then(
    () => true,
    () => false
  );

/** Resolve a bare command name against PATH plus well-known install dirs; absolute paths pass through. */
async function resolveCommand(command: string): Promise<string> {
  if (isAbsolute(command) || command.includes("/") || process.platform === "win32") return command;
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of [...pathDirs, ...extraSearchDirs()]) {
    const candidate = join(dir, command);
    if (await isExecutable(candidate)) return candidate;
  }
  throw new Error(`Editor command "${command}" not found on PATH — set an absolute path in the plugin settings`);
}

function launch(command: string, args: string[]): void {
  if (command.includes("\0") || args.some((argument) => argument.includes("\0"))) throw new Error("Invalid null byte in launch argument");
  const child = spawn(command, args, { shell: false, detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => undefined);
  child.unref();
}

export async function openEditor(command: string, baseArgs: string[], projectRoot: string): Promise<void> {
  if (!command.trim() || command.includes("\0") || projectRoot.includes("\0")) throw new Error("Invalid editor launch settings");
  if (!(await stat(projectRoot)).isDirectory()) throw new Error("Project directory does not exist");
  launch(await resolveCommand(command.trim()), [...baseArgs, projectRoot]);
}

export async function openDirectory(directory: string): Promise<void> {
  if (!(await stat(directory)).isDirectory()) throw new Error("Directory does not exist");
  if (process.platform === "darwin") launch("/usr/bin/open", [directory]);
  else if (process.platform === "win32") launch("explorer.exe", [directory]);
  else launch("xdg-open", [directory]);
}
