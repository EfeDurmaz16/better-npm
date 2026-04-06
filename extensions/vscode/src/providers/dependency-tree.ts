import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import * as path from 'path';

interface DepNode {
  name: string;
  version: string;
  type: 'prod' | 'dev' | 'peer' | 'optional';
  children?: DepNode[];
}

export class DependencyTreeItem extends vscode.TreeItem {
    constructor(
        public readonly dep: DepNode,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(dep.name, collapsibleState);
        this.description = dep.version;
        this.tooltip = `${dep.name}@${dep.version} (${dep.type})`;
        this.contextValue = 'dependency';
        this.iconPath = new vscode.ThemeIcon(
            dep.type === 'dev' ? 'tools' : 'package'
        );
        this.command = {
            command: 'better.context',
            title: 'Show Context',
            arguments: [dep.name]
        };
    }
}

export class DependencyTreeProvider implements vscode.TreeDataProvider<DependencyTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DependencyTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _deps: DepNode[] = [];
    private _loaded = false;

    refresh(): void {
        this._loaded = false;
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: DependencyTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: DependencyTreeItem): Promise<DependencyTreeItem[]> {
        if (element) {
            return (element.dep.children || []).map(child =>
                new DependencyTreeItem(
                    child,
                    child.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                )
            );
        }

        if (!this._loaded) {
            await this._loadDeps();
            this._loaded = true;
        }

        return this._deps.map(dep =>
            new DependencyTreeItem(
                dep,
                dep.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            )
        );
    }

    private async _loadDeps(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        const cwd = workspaceFolders[0].uri.fsPath;
        try {
            const config = vscode.workspace.getConfiguration('better');
            const binary = config.get<string>('binaryPath', 'better');

            const output = execFileSync(binary, ['list', '--json', '--depth', '1'], {
                cwd,
                timeout: 10000,
                encoding: 'utf8'
            });

            const result = JSON.parse(output);
            if (result.packages && Array.isArray(result.packages)) {
                this._deps = result.packages.map((p: { name: string; version: string; type?: string }) => ({
                    name: p.name,
                    version: p.version,
                    type: p.type || 'prod'
                }));
            }
        } catch {
            // Load from package.json as fallback
            try {
                const pkgPath = path.join(cwd, 'package.json');
                const pkgContent = require('fs').readFileSync(pkgPath, 'utf8');
                const pkg = JSON.parse(pkgContent);

                this._deps = [
                    ...Object.entries(pkg.dependencies || {}).map(([name, version]) => ({
                        name, version: String(version), type: 'prod' as const
                    })),
                    ...Object.entries(pkg.devDependencies || {}).map(([name, version]) => ({
                        name, version: String(version), type: 'dev' as const
                    }))
                ];
            } catch {
                this._deps = [];
            }
        }
    }
}
