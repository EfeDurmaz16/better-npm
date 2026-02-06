import type { ParsedArgs } from '../parser.js';
import type { Output } from '../output.js';

export interface BetterConfig {
  [key: string]: unknown;
}

export interface CommandContext {
  args: ParsedArgs;
  output: Output;
  config: BetterConfig;
}

export interface Command {
  name: string;
  description: string;
  run(ctx: CommandContext): Promise<number>;
}

export const commands: Map<string, Command> = new Map();

export function registerCommand(cmd: Command): void {
  commands.set(cmd.name, cmd);
}

export function getCommand(name: string): Command | undefined {
  return commands.get(name);
}
