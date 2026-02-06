import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCacheManager } from '../cache/manager.js';
import { buildDependencyGraph } from '../analyzer/graph.js';
import { detectDuplicates } from '../analyzer/duplicates.js';
import { analyzeDepth } from '../analyzer/depth.js';
import { detectDeprecated } from '../analyzer/deprecation.js';
import { HealthEngine } from '../doctor/engine.js';
import { depthCheck } from '../doctor/checks/depth.js';
import { duplicatesCheck } from '../doctor/checks/duplicates.js';
import { deprecatedCheck } from '../doctor/checks/deprecated.js';
import { sizeCheck } from '../doctor/checks/size.js';
import { calculateSize } from '../fs/size.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ServerConfig {
  port: number;
  cwd: string;
}

export class WebServer {
  private server: http.Server | null = null;
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(err => {
        console.error('Request handler error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, () => {
        console.log(`Server listening on http://localhost:${this.config.port}`);
        resolve();
      });

      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve, reject) => {
      this.server!.close(err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Add CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    // API endpoints
    if (url.pathname.startsWith('/api/')) {
      await this.handleApiRequest(url.pathname, res);
      return;
    }

    // Static file serving
    await this.handleStaticFile(url.pathname, res);
  }

  private async handleApiRequest(
    pathname: string,
    res: http.ServerResponse
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json');

    try {
      if (pathname === '/api/analyze') {
        const data = await this.getAnalyzeData();
        res.writeHead(200);
        res.end(JSON.stringify(data, null, 2));
      } else if (pathname === '/api/health') {
        const data = await this.getHealthData();
        res.writeHead(200);
        res.end(JSON.stringify(data, null, 2));
      } else if (pathname === '/api/cache/stats') {
        const data = await this.getCacheStats();
        res.writeHead(200);
        res.end(JSON.stringify(data, null, 2));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not Found' }));
      }
    } catch (error) {
      console.error('API error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  private async handleStaticFile(
    pathname: string,
    res: http.ServerResponse
  ): Promise<void> {
    // Serve index.html for root path
    if (pathname === '/') {
      pathname = '/index.html';
    }

    // Security: prevent directory traversal
    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    const publicDir = path.join(__dirname, 'public');
    const filePath = path.join(publicDir, safePath);

    // Ensure file is within public directory
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // Check if file exists
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    // Determine content type
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';

    // Read and serve file
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  }

  private async getAnalyzeData(): Promise<any> {
    const nodeModulesPath = path.join(this.config.cwd, 'node_modules');

    if (!fs.existsSync(nodeModulesPath)) {
      return {
        error: 'No node_modules found',
        message: 'Run npm install first'
      };
    }

    const graph = buildDependencyGraph(nodeModulesPath);
    const duplicates = detectDuplicates(graph);
    const depth = analyzeDepth(graph);
    const deprecated = detectDeprecated(graph, this.config.cwd);

    const sizeResult = calculateSize(nodeModulesPath, {
      excludeDirs: ['.git', '.DS_Store'],
    });

    // Convert Map to object for JSON serialization
    const packagesObj: Record<string, any> = {};
    graph.packages.forEach((value, key) => {
      packagesObj[key] = value;
    });

    // Convert depth distribution Map to object
    const depthDistributionObj: Record<number, string[]> = {};
    depth.depthDistribution.forEach((value, key) => {
      depthDistributionObj[key] = value;
    });

    return {
      totalPackages: graph.totalPackages,
      totalSize: sizeResult.physicalSize,
      graph: {
        root: graph.root,
        packages: packagesObj,
        totalPackages: graph.totalPackages,
      },
      duplicates: {
        duplicates: duplicates.duplicates,
        totalWastedBytes: duplicates.totalWastedBytes,
        totalDuplicatePackages: duplicates.totalDuplicatePackages,
      },
      depth: {
        maxDepth: depth.maxDepth,
        longestChain: depth.longestChain,
        depthDistribution: depthDistributionObj,
        averageDepth: depth.averageDepth,
      },
      deprecated: {
        deprecatedPackages: deprecated.deprecatedPackages,
        totalDeprecated: deprecated.totalDeprecated,
      },
      size: {
        logical: sizeResult.logicalSize,
        physical: sizeResult.physicalSize,
        savings: sizeResult.logicalSize - sizeResult.physicalSize,
        fileCount: sizeResult.fileCount,
      },
    };
  }

  private async getHealthData(): Promise<any> {
    const nodeModulesPath = path.join(this.config.cwd, 'node_modules');

    if (!fs.existsSync(nodeModulesPath)) {
      return {
        error: 'No node_modules found',
        message: 'Run npm install first'
      };
    }

    const graph = buildDependencyGraph(nodeModulesPath);
    const duplicates = detectDuplicates(graph);
    const depth = analyzeDepth(graph);
    const deprecated = detectDeprecated(graph, this.config.cwd);

    const engine = new HealthEngine();
    engine.register(depthCheck);
    engine.register(duplicatesCheck);
    engine.register(deprecatedCheck);
    engine.register(sizeCheck);

    const report = await engine.run({
      cwd: this.config.cwd,
      graph,
      duplicates,
      depth,
      deprecated,
    });

    // Calculate individual component scores
    const duplicateScore = duplicates.totalDuplicatePackages === 0 ? 100 :
      Math.max(0, 100 - (duplicates.totalDuplicatePackages * 5));

    const deprecationScore = deprecated.totalDeprecated === 0 ? 100 :
      Math.max(0, 100 - (deprecated.totalDeprecated * 10));

    const depthScore = depth.maxDepth <= 5 ? 100 :
      Math.max(0, 100 - ((depth.maxDepth - 5) * 5));

    const sizeScore = 85; // Placeholder, can be calculated based on size metrics

    return {
      score: report.score,
      grade: this.getGrade(report.score),
      findings: report.findings,
      checksPassed: report.checksPassed,
      checksFailed: report.checksFailed,
      duplicateScore,
      deprecationScore,
      depthScore,
      sizeScore,
    };
  }

  private async getCacheStats(): Promise<any> {
    const cacheManager = getCacheManager();
    await cacheManager.initialize();
    const stats = await cacheManager.getStats();

    return {
      root: stats.root,
      totalSize: stats.totalSize,
      packageCount: stats.packageCount,
      oldestEntry: stats.oldestEntry,
      newestEntry: stats.newestEntry,
    };
  }

  private getGrade(score: number): string {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }
}
