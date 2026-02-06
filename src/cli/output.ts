export interface OutputOptions {
  json: boolean;
  color: boolean;
}

export class Output {
  constructor(private options: OutputOptions) {}

  log(message: string): void {
    if (!this.options.json) {
      console.log(message);
    }
  }

  json(data: unknown): void {
    console.log(JSON.stringify(data, null, 2));
  }

  error(message: string): void {
    if (this.options.json) {
      this.json({ error: message });
    } else {
      console.error(this.formatError(message));
    }
  }

  success(message: string): void {
    if (!this.options.json) {
      const checkmark = this.options.color ? '\u2713' : '✓';
      console.log(`${checkmark} ${message}`);
    }
  }

  warn(message: string): void {
    if (!this.options.json) {
      const warning = this.options.color ? '\u26A0' : '⚠';
      console.warn(`${warning} ${message}`);
    }
  }

  table(headers: string[], rows: string[][]): string {
    if (rows.length === 0) {
      return '';
    }

    // Calculate column widths
    const colWidths = headers.map((header, i) => {
      const maxRowWidth = Math.max(...rows.map(row => (row[i] || '').length));
      return Math.max(header.length, maxRowWidth);
    });

    // Build header
    const headerRow = headers
      .map((header, i) => {
        const width = colWidths[i];
        return width !== undefined ? header.padEnd(width) : header;
      })
      .join('  ');

    const separator = colWidths.map(width => '-'.repeat(width || 0)).join('  ');

    // Build rows
    const dataRows = rows.map(row =>
      row.map((cell, i) => {
        const width = colWidths[i];
        return width !== undefined ? (cell || '').padEnd(width) : (cell || '');
      }).join('  ')
    );

    return [headerRow, separator, ...dataRows].join('\n');
  }

  private formatError(message: string): string {
    if (this.options.color) {
      return `\x1b[31mError:\x1b[0m ${message}`;
    }
    return `Error: ${message}`;
  }
}

export function createOutput(options: Partial<OutputOptions> = {}): Output {
  const defaults: OutputOptions = {
    json: false,
    color: process.stdout.isTTY !== false,
  };

  return new Output({ ...defaults, ...options });
}
