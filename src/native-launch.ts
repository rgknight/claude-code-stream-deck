import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

function launch(command: string, args: string[]): void {
  if (command.includes("\0") || args.some((argument) => argument.includes("\0"))) throw new Error("Invalid null byte in launch argument");
  const child = spawn(command, args, { shell: false, detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => undefined);
  child.unref();
}

export async function openEditor(command: string, baseArgs: string[], projectRoot: string): Promise<void> {
  if (!command.trim() || command.includes("\0") || projectRoot.includes("\0")) throw new Error("Invalid editor launch settings");
  if (!(await stat(projectRoot)).isDirectory()) throw new Error("Project directory does not exist");
  launch(command, [...baseArgs, projectRoot]);
}

export async function openDirectory(directory: string): Promise<void> {
  if (!(await stat(directory)).isDirectory()) throw new Error("Directory does not exist");
  if (process.platform === "darwin") launch("/usr/bin/open", [directory]);
  else if (process.platform === "win32") launch("explorer.exe", [directory]);
  else launch("xdg-open", [directory]);
}
