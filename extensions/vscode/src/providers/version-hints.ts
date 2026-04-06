import * as vscode from 'vscode';
import { execFileSync } from 'child_process';

interface OutdatedResult {
  ok: boolean;
  packages?: Array<{
    name: string;
    current: string;
    latest: string;
    type: string;
  }>;
}

export class VersionHintProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!document.fileName.endsWith('package.json')) return [];

        let pkg: Record<string, unknown>;
        try {
            pkg = JSON.parse(document.getText());
        } catch {
            return [];
        }

        const lenses: vscode.CodeLens[] = [];
        const text = document.getText();

        // Parse the document to find dependency positions
        const depSections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
        for (const section of depSections) {
            const deps = pkg[section] as Record<string, string> | undefined;
            if (!deps) continue;

            for (const [name] of Object.entries(deps)) {
                // Find the position of this package in the document
                const pattern = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`);
                const match = pattern.exec(text);
                if (!match) continue;

                const pos = document.positionAt(match.index);
                const range = new vscode.Range(pos, pos);

                lenses.push(new vscode.CodeLens(range, {
                    title: `$(loading~spin) Checking ${name}...`,
                    command: 'better.context',
                    arguments: [name]
                }));
            }
        }

        // Kick off async check and refresh
        this.checkOutdated(document).then(() => {
            this._onDidChangeCodeLenses.fire();
        }).catch(() => {});

        return lenses;
    }

    resolveCodeLens(lens: vscode.CodeLens): vscode.CodeLens {
        return lens;
    }

    private _outdatedCache = new Map<string, OutdatedResult>();

    private async checkOutdated(document: vscode.TextDocument): Promise<void> {
        const cacheKey = document.uri.fsPath;
        if (this._outdatedCache.has(cacheKey)) return;

        try {
            const config = vscode.workspace.getConfiguration('better');
            const binary = config.get<string>('binaryPath', 'better');
            const cwd = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
            if (!cwd) return;

            const output = execFileSync(binary, ['outdated', '--json'], {
                cwd,
                timeout: 15000,
                encoding: 'utf8'
            });

            const result: OutdatedResult = JSON.parse(output);
            this._outdatedCache.set(cacheKey, result);
        } catch {
            // Binary not available or command failed — silently skip
        }
    }

    dispose() {
        this._onDidChangeCodeLenses.dispose();
    }
}
