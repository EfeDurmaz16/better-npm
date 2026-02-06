import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli/parser.js';

describe('CLI Argument Parser', () => {
  describe('command parsing', () => {
    it('should parse command with no flags', () => {
      const result = parseArgs(['analyze']);
      expect(result.command).toBe('analyze');
      expect(result.positionals).toEqual([]);
      expect(result.flags).toEqual({});
    });

    it('should parse command with positional arguments', () => {
      const result = parseArgs(['install', 'package1', 'package2']);
      expect(result.command).toBe('install');
      expect(result.positionals).toEqual(['package1', 'package2']);
      expect(result.flags).toEqual({});
    });

    it('should handle no arguments', () => {
      const result = parseArgs([]);
      expect(result.command).toBeUndefined();
      expect(result.positionals).toEqual([]);
      expect(result.flags).toEqual({});
    });
  });

  describe('long flags', () => {
    it('should parse long flag with boolean value', () => {
      const result = parseArgs(['analyze', '--verbose']);
      expect(result.command).toBe('analyze');
      expect(result.flags.verbose).toBe(true);
    });

    it('should parse long flag with value', () => {
      const result = parseArgs(['analyze', '--config', 'custom.json']);
      expect(result.command).toBe('analyze');
      expect(result.flags.config).toBe('custom.json');
    });

    it('should parse long flag with equals syntax', () => {
      const result = parseArgs(['analyze', '--config=custom.json']);
      expect(result.command).toBe('analyze');
      expect(result.flags.config).toBe('custom.json');
    });

    it('should parse multiple long flags', () => {
      const result = parseArgs(['analyze', '--verbose', '--json', '--output', 'report.json']);
      expect(result.flags.verbose).toBe(true);
      expect(result.flags.json).toBe(true);
      expect(result.flags.output).toBe('report.json');
    });

    it('should handle long flag at end as boolean', () => {
      const result = parseArgs(['analyze', '--verbose']);
      expect(result.flags.verbose).toBe(true);
    });

    it('should handle empty value after equals', () => {
      const result = parseArgs(['analyze', '--value=']);
      expect(result.flags.value).toBe('');
    });
  });

  describe('short flags', () => {
    it('should parse short flag with boolean value', () => {
      const result = parseArgs(['analyze', '-v']);
      expect(result.command).toBe('analyze');
      expect(result.flags.v).toBe(true);
    });

    it('should parse short flag with value', () => {
      const result = parseArgs(['analyze', '-o', 'output.txt']);
      expect(result.command).toBe('analyze');
      expect(result.flags.o).toBe('output.txt');
    });

    it('should parse multiple short flags', () => {
      const result = parseArgs(['analyze', '-v', '-j', '-o', 'out.json']);
      expect(result.flags.v).toBe(true);
      expect(result.flags.j).toBe(true);
      expect(result.flags.o).toBe('out.json');
    });

    it('should handle short flag at end as boolean', () => {
      const result = parseArgs(['analyze', '-v']);
      expect(result.flags.v).toBe(true);
    });
  });

  describe('combined short flags', () => {
    it('should expand combined short flags', () => {
      const result = parseArgs(['analyze', '-vjq']);
      // Combined flags are expanded as individual boolean flags
      expect(result.flags.v).toBe(true);
      expect(result.flags.j).toBe(true);
      expect(result.flags.q).toBe(true);
    });
  });

  describe('mixed flags and positionals', () => {
    it('should parse command with flags before and after positionals', () => {
      const result = parseArgs(['install', '--save-dev', 'package1', '--verbose']);
      expect(result.command).toBe('install');
      // The parser treats 'package1' after --save-dev as a value for the flag
      expect(result.flags['save-dev']).toBe('package1');
      expect(result.flags.verbose).toBe(true);
    });

    it('should handle flags interspersed with positionals', () => {
      const result = parseArgs(['cmd', 'pos1', '--flag1', 'pos2', '--flag2', 'value']);
      expect(result.command).toBe('cmd');
      // pos2 is treated as value for flag1
      expect(result.positionals).toEqual(['pos1']);
      expect(result.flags.flag1).toBe('pos2');
      expect(result.flags.flag2).toBe('value');
    });
  });

  describe('special cases', () => {
    it('should handle single dash as positional', () => {
      const result = parseArgs(['cmd', '-']);
      expect(result.command).toBe('cmd');
      expect(result.positionals).toEqual(['-']);
    });

    it('should handle empty strings in args', () => {
      const result = parseArgs(['cmd', '', 'arg']);
      expect(result.command).toBe('cmd');
      expect(result.positionals).toEqual(['arg']);
    });

    it('should handle flags that look like values', () => {
      const result = parseArgs(['analyze', '--port', '8080']);
      expect(result.flags.port).toBe('8080');
    });

    it('should handle negative numbers as values', () => {
      const result = parseArgs(['analyze', '--offset', '-10']);
      // The parser now correctly identifies -10 as a negative number, not a flag
      expect(result.flags.offset).toBe('-10');
    });

    it('should handle flag followed by another flag', () => {
      const result = parseArgs(['analyze', '--verbose', '--json']);
      expect(result.flags.verbose).toBe(true);
      expect(result.flags.json).toBe(true);
    });
  });

  describe('real-world examples', () => {
    it('should parse analyze command', () => {
      const result = parseArgs(['analyze', '--depth', '5', '--json']);
      expect(result.command).toBe('analyze');
      expect(result.flags.depth).toBe('5');
      expect(result.flags.json).toBe(true);
    });

    it('should parse install command', () => {
      const result = parseArgs(['install', 'lodash', 'axios', '--save-dev']);
      expect(result.command).toBe('install');
      expect(result.positionals).toEqual(['lodash', 'axios']);
      expect(result.flags['save-dev']).toBe(true);
    });

    it('should parse doctor command', () => {
      const result = parseArgs(['doctor', '--fix', '--threshold=80']);
      expect(result.command).toBe('doctor');
      expect(result.flags.fix).toBe(true);
      expect(result.flags.threshold).toBe('80');
    });
  });
});
