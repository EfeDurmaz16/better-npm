import * as vscode from 'vscode';
import { VersionHintProvider } from './providers/version-hints';
import { AuditDiagnosticProvider } from './providers/audit-diagnostics';
import { DependencyTreeProvider } from './providers/dependency-tree';

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('better');

    // Inline version hints (CodeLens on package.json deps)
    if (config.get<boolean>('showVersionHints', true)) {
        const versionHints = new VersionHintProvider();
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider(
                { pattern: '**/package.json', scheme: 'file' },
                versionHints
            )
        );
    }

    // Audit gutter diagnostics
    const auditDiag = new AuditDiagnosticProvider(context);
    context.subscriptions.push(auditDiag);

    // Sidebar dependency tree
    const depTree = new DependencyTreeProvider();
    vscode.window.registerTreeDataProvider('betterDeps', depTree);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('better.audit', () => {
            auditDiag.runAudit();
        }),
        vscode.commands.registerCommand('better.update', (pkgName: string) => {
            if (pkgName) {
                vscode.window.showInformationMessage(`Updating ${pkgName}...`);
                const terminal = vscode.window.createTerminal('Better Update');
                terminal.sendText(`better update ${pkgName}`);
                terminal.show();
            }
        }),
        vscode.commands.registerCommand('better.context', (pkgName: string) => {
            if (pkgName) {
                const panel = vscode.window.createWebviewPanel(
                    'betterContext',
                    `Better: ${pkgName}`,
                    vscode.ViewColumn.Beside,
                    { enableScripts: true }
                );
                panel.webview.html = getContextPanelHtml(pkgName);
            }
        }),
        vscode.commands.registerCommand('better.provision', () => {
            const terminal = vscode.window.createTerminal('Better OSP');
            terminal.sendText('better infra provision');
            terminal.show();
        })
    );

    // Auto-audit on save if configured
    if (config.get<boolean>('auditOnSave', true)) {
        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (doc.fileName.endsWith('package.json') && !doc.fileName.includes('node_modules')) {
                    auditDiag.runAudit();
                }
            })
        );
    }

    // Set context key to show views
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        const rootPath = workspaceFolders[0].uri.fsPath;
        vscode.workspace.fs.stat(vscode.Uri.file(`${rootPath}/package.json`))
            .then(() => {
                vscode.commands.executeCommand('setContext', 'better.projectDetected', true);
            })
            .then(undefined, () => { /* no package.json */ });
    }
}

export function deactivate() {}

function getContextPanelHtml(pkgName: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${pkgName}</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 16px; }
        h1 { color: var(--vscode-editor-foreground); }
        .loading { color: var(--vscode-descriptionForeground); }
    </style>
</head>
<body>
    <h1>${pkgName}</h1>
    <p class="loading">Loading package context...</p>
    <script>
        const vscode = acquireVsCodeApi();
        // Context would be loaded via better context command output
    </script>
</body>
</html>`;
}
