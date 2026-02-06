import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import http from "node:http";
import { execFile } from "node:child_process";
import os from "node:os";
import { analyzeProject } from "../analyze/analyzeProject.js";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";

async function openBrowser(url) {
  const platform = os.platform();
  let command;
  let args;

  switch (platform) {
    case "darwin":
      command = "open";
      args = [url];
      break;
    case "win32":
      command = "cmd";
      args = ["/c", "start", url];
      break;
    default:
      command = "xdg-open";
      args = [url];
      break;
  }

  return new Promise((resolve) => {
    execFile(command, args, (err) => {
      // Silently resolve even if browser can't be opened
      resolve();
    });
  });
}

async function startServer(analysis, port) {
  const html = await fs.readFile(new URL("../ui/index.html", import.meta.url), "utf8");
  const js = await fs.readFile(new URL("../ui/app.js", import.meta.url), "utf8");
  const css = await fs.readFile(new URL("../ui/style.css", import.meta.url), "utf8");

  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.url === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(js);
      return;
    }
    if (req.url === "/style.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(css);
      return;
    }
    if (req.url === "/analysis.json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(`${JSON.stringify(analysis, null, 2)}\n`);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  const url = `http://127.0.0.1:${boundPort}/`;
  return { server, port: boundPort, url };
}

export async function cmdServe(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better serve [--port N] [--no-open] [--json]
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", short: "p", default: "3000" },
      "no-open": { type: "boolean", default: false },
      json: { type: "boolean", default: runtime.json === true }
    },
    allowPositionals: true,
    strict: false
  });

  const parsedPort = Number(values.port);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 3000;
  const noOpen = values["no-open"];
  const projectRoot = process.cwd();

  if (!values?.json) {
    printText(`Analyzing project at ${projectRoot}...`);
  }

  const analysis = await analyzeProject(projectRoot, { includeGraph: true });

  if (!analysis.ok) {
    if (values.json) {
      printJson({
        ok: false,
        kind: "better.serve",
        schemaVersion: 1,
        reason: analysis.reason
      });
    } else {
      printText(`Error: ${analysis.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  try {
    const started = await startServer(analysis, port);
    const url = started.url;
    if (values.json) {
      printJson({
        ok: true,
        kind: "better.serve",
        schemaVersion: 1,
        projectRoot,
        port: started.port,
        url
      });
    }
    if (!values.json) {
      printText(`Server running at ${url}`);
      printText("Press Ctrl+C to stop");
    }

    if (!noOpen) {
      await openBrowser(url);
    }

    // Keep the process alive
    await new Promise(() => {});
  } catch (err) {
    if (values.json) {
      printJson({
        ok: false,
        kind: "better.serve",
        schemaVersion: 1,
        reason: err?.message ?? String(err)
      });
    } else {
      printText(`Failed to start server: ${err.message}`);
    }
    process.exitCode = 1;
  }
}
