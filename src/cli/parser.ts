export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: undefined,
    positionals: [],
    flags: {},
  };

  let i = 0;
  let commandFound = false;

  // Helper to check if a string looks like a flag (not a negative number)
  const isFlag = (str: string): boolean => {
    if (!str.startsWith('-')) return false;
    // Single dash is not a flag
    if (str === '-') return false;
    // Check if it's a negative number: starts with - followed by digits (optionally with decimal)
    const negativeNumberPattern = /^-\d+(\.\d+)?$/;
    return !negativeNumberPattern.test(str);
  };

  while (i < args.length) {
    const arg = args[i];
    if (!arg) {
      i++;
      continue;
    }

    if (arg.startsWith('--')) {
      // Long flag: --flag or --flag=value
      const equalIndex = arg.indexOf('=');
      if (equalIndex !== -1) {
        const key = arg.slice(2, equalIndex);
        const value = arg.slice(equalIndex + 1);
        result.flags[key] = value;
      } else {
        const key = arg.slice(2);
        const nextArg = args[i + 1];
        // Check if next arg is a value (not a flag)
        if (i + 1 < args.length && nextArg && !isFlag(nextArg)) {
          result.flags[key] = nextArg;
          i++; // Skip next arg as it's the value
        } else {
          result.flags[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1 && arg !== '-') {
      // Short flag: -f or -f value
      const key = arg.slice(1);

      // Handle multiple short flags like -abc as -a -b -c
      if (key.length > 1) {
        for (const char of key) {
          result.flags[char] = true;
        }
      } else {
        const nextArg = args[i + 1];
        // Single short flag, check for value
        if (i + 1 < args.length && nextArg && !isFlag(nextArg)) {
          result.flags[key] = nextArg;
          i++; // Skip next arg as it's the value
        } else {
          result.flags[key] = true;
        }
      }
    } else {
      // Positional argument
      if (!commandFound) {
        result.command = arg;
        commandFound = true;
      } else {
        result.positionals.push(arg);
      }
    }

    i++;
  }

  return result;
}
