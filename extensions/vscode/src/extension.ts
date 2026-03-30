import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
    diagnosticCollection = vscode.languages.createDiagnosticCollection('better');
    context.subscriptions.push(diagnosticCollection);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('better.audit', runAudit),
        vscode.commands.registerCommand('better.outdated', runOutdated),
        vscode.commands.registerCommand('better.install', runInstall),
        vscode.commands.registerCommand('better.context', showContext),
    );

    // Run audit on workspace open
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        runAuditInBackground(workspaceRoot);
    }
}

function runAudit() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;

    const terminal = vscode.window.createTerminal('better audit');
    terminal.sendText('better audit');
    terminal.show();

    runAuditInBackground(root);
}

function runAuditInBackground(root: string) {
    cp.execFile('better', ['audit', '--json'], { cwd: root }, (err, stdout) => {
        if (!stdout) return;
        try {
            const result = JSON.parse(stdout);
            const diagnostics: vscode.Diagnostic[] = [];

            if (result.vulnerabilities) {
                const pkgJsonUri = vscode.Uri.file(path.join(root, 'package.json'));
                for (const vuln of result.vulnerabilities) {
                    const severity = vuln.severity === 'critical' || vuln.severity === 'high'
                        ? vscode.DiagnosticSeverity.Error
                        : vscode.DiagnosticSeverity.Warning;
                    const range = new vscode.Range(0, 0, 0, 0);
                    const msg = `[better audit] ${vuln.package}: ${vuln.title} (${vuln.severity})`;
                    diagnostics.push(new vscode.Diagnostic(range, msg, severity));
                }
                diagnosticCollection.set(pkgJsonUri, diagnostics);
            }
        } catch { /* ignore parse errors */ }
    });
}

function runOutdated() {
    const terminal = vscode.window.createTerminal('better outdated');
    terminal.sendText('better outdated');
    terminal.show();
}

function runInstall() {
    const terminal = vscode.window.createTerminal('better install');
    terminal.sendText('better install');
    terminal.show();
}

function showContext() {
    const terminal = vscode.window.createTerminal('better context');
    terminal.sendText('better context --all');
    terminal.show();
}

export function deactivate() {
    diagnosticCollection?.dispose();
}
