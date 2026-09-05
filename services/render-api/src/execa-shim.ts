import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export async function execa(cmd: string, args: string[]) {
  const { stdout } = await execFileAsync(cmd, args);
  return stdout;
}
