import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

interface AuditVulnerability {
  name: string;
  severity: 'critical' | 'high' | 'moderate' | 'low' | 'info';
  title: string;
  url?: string;
  version?: string;
}

interface AuditResult {
  ok: boolean;
  vulnerabilities?: AuditVulnerability[];
  summary?: {
    critical: number;
    high: number;
    moderate: number;
    low: number;
  };
}

export class AuditDiagnosticProvider implements vscode.Disposable {
    private readonly _diagnostics: vscode.DiagnosticCollection;
    private _context: vscode.ExtensionContext;
    private _running = false;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this._diagnostics = vscode.languages.createDiagnosticCollection('better-audit');
        context.subscriptions.push(this._diagnostics);

        // Run initial audit after a short delay
        setTimeout(() => this.runAudit(), 3000);
    }

    async runAudit(): Promise<void> {
        if (this._running) return;
        this._running = true;

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;

            for (const folder of workspaceFolders) {
                await this._auditFolder(folder.uri.fsPath);
            }
        } finally {
            this._running = false;
        }
    }

    private async _auditFolder(cwd: string): Promise<void> {
        const pkgJsonPath = path.join(cwd, 'package.json');
        const pkgJsonUri = vscode.Uri.file(pkgJsonPath);

        try {
            const config = vscode.workspace.getConfiguration('better');
            const binary = config.get<string>('binaryPath', 'better');

            const { stdout } = await execFileAsync(binary, ['audit', '--json'], {
                cwd,
                timeout: 30000
            });

            const result: AuditResult = JSON.parse(stdout);
            const diagnostics: vscode.Diagnostic[] = [];

            if (result.vulnerabilities && result.vulnerabilities.length > 0) {
                for (const vuln of result.vulnerabilities) {
                    const severity = this._mapSeverity(vuln.severity);
                    const diag = new vscode.Diagnostic(
                        new vscode.Range(0, 0, 0, 0),
                        `${vuln.name}: ${vuln.title} (${vuln.severity})`,
                        severity
                    );
                    diag.source = 'better audit';
                    diag.code = { value: vuln.severity.toUpperCase(), target: vscode.Uri.parse(`https://npmjs.com/advisories`) };
                    diagnostics.push(diag);
                }
            }

            this._diagnostics.set(pkgJsonUri, diagnostics);
        } catch {
            // Binary not available or audit failed — clear diagnostics silently
            this._diagnostics.delete(pkgJsonUri);
        }
    }

    private _mapSeverity(severity: string): vscode.DiagnosticSeverity {
        switch (severity) {
            case 'critical':
            case 'high':
                return vscode.DiagnosticSeverity.Error;
            case 'moderate':
                return vscode.DiagnosticSeverity.Warning;
            default:
                return vscode.DiagnosticSeverity.Information;
        }
    }

    dispose(): void {
        this._diagnostics.dispose();
    }
}
