// Larimar for VS Code: finds the Larimar installation (LARIMAR_HOME) and starts its language server,
// `bin/larimarc lsp`, which answers everything (errors, hover, definition, references, symbols,
// completion, signature help). It also debugs: `larimar build --debug` writes the C with #line to the
// .lar files and a debug map, and `larimar dap` (the debugger, written in Larimar, over lldb-dap) shows
// breakpoints, steps, the stack and the values as Larimar. CodeLLDB or the C/C++ extension with gdb
// (with the formatters of $LARIMAR_HOME/debug) remain as alternatives (larimar.debugger).

import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let output: vscode.OutputChannel;
let terminal: vscode.Terminal | undefined;

const EXE = process.platform === "win32" ? "larimarc.exe" : "larimarc";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    output = vscode.window.createOutputChannel("Larimar");
    context.subscriptions.push(output);

    context.subscriptions.push(
        vscode.commands.registerCommand("larimar.restartServer", async () => {
            await stopServer();
            registerFormatter(context);
            await startServer(context);
        }),
        vscode.commands.registerCommand("larimar.run", () => runInTerminal("run")),
        vscode.commands.registerCommand("larimar.build", () => runInTerminal("build")),
        vscode.commands.registerCommand("larimar.check", () => runInTerminal("check")),
        vscode.commands.registerCommand("larimar.showC", showGeneratedC),
        vscode.commands.registerCommand("larimar.debug", () =>
            vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
                type: "larimar", request: "launch", name: "Debug Larimar project"
            })),
        vscode.debug.registerDebugConfigurationProvider("larimar", new LarimarDebugProvider()),
        vscode.debug.registerDebugAdapterDescriptorFactory("larimar", new LarimarDebugAdapterFactory()),
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration("larimar.home") || e.affectsConfiguration("larimar.server.enabled")) {
                await stopServer();
                await startServer(context);
            }
        }),
        vscode.window.onDidCloseTerminal((t) => {
            if (t === terminal) { terminal = undefined; }
        })
    );

    await startServer(context);
}

export async function deactivate(): Promise<void> {
    await stopServer();
}

// ---------------------------------------------------------------------------------------------
// Finding Larimar
// ---------------------------------------------------------------------------------------------

/** A Larimar installation: a folder with bin/larimarc. */
function isHome(dir: string | undefined): dir is string {
    return !!dir && fs.existsSync(path.join(dir, "bin", EXE));
}

/** larimar.home, then $LARIMAR_HOME, then larimar on the PATH, then the login shell's LARIMAR_HOME. */
function findHome(): string | undefined {
    const configured = vscode.workspace.getConfiguration("larimar").get<string>("home", "").trim();
    if (configured) {
        const dir = expandHome(configured);
        if (isHome(dir)) { return dir; }
        output.appendLine(`larimar.home is "${configured}", but ${path.join(dir, "bin", EXE)} does not exist.`);
    }
    const env = process.env.LARIMAR_HOME;
    if (isHome(env)) { return env; }

    const onPath = findOnPath(process.platform === "win32" ? ["larimarc.exe", "larimar.cmd", "larimar.bat"] : ["larimar", "larimarc"]);
    if (onPath) {
        const dir = path.dirname(path.dirname(realPath(onPath)));     // <home>/bin/larimar
        if (isHome(dir)) { return dir; }
    }

    // On macOS and Linux, VS Code started from the dock does not see what the shell's profile exports.
    if (process.platform !== "win32") {
        const fromShell = loginShellVariable("LARIMAR_HOME");
        if (isHome(fromShell)) { return fromShell; }
    }
    return undefined;
}

function expandHome(p: string): string {
    if (p === "~" || p.startsWith("~/")) { return path.join(process.env.HOME ?? "", p.slice(1)); }
    return p;
}

function realPath(p: string): string {
    try { return fs.realpathSync(p); } catch { return p; }
}

function findOnPath(names: string[]): string | undefined {
    const dirs = (process.env.PATH ?? "").split(path.delimiter);
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (fs.existsSync(candidate)) { return candidate; }
        }
    }
    return undefined;
}

function loginShellVariable(name: string): string | undefined {
    const shell = process.env.SHELL || "/bin/sh";
    try {
        const out = cp.execFileSync(shell, ["-l", "-i", "-c", `printf '%s' "$${name}"`], {
            encoding: "utf8",
            timeout: 3000,
            stdio: ["ignore", "pipe", "ignore"]
        });
        const value = out.trim().split("\n").pop()?.trim();
        return value ? value : undefined;
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------------------------
// The language server
// ---------------------------------------------------------------------------------------------

async function startServer(context: vscode.ExtensionContext): Promise<void> {
    if (!vscode.workspace.getConfiguration("larimar").get<boolean>("server.enabled", true)) { return; }
    const home = findHome();
    if (!home) {
        const choice = await vscode.window.showWarningMessage(
            "Larimar was not found: set LARIMAR_HOME or the larimar.home setting to the folder that has bin/larimarc. Only the colors will work until then.",
            "Open Settings"
        );
        if (choice === "Open Settings") {
            await vscode.commands.executeCommand("workbench.action.openSettings", "larimar.home");
        }
        return;
    }
    const command = path.join(home, "bin", EXE);
    output.appendLine(`Larimar: ${home}`);
    const env = { ...process.env, LARIMAR_HOME: home };
    const serverOptions: ServerOptions = {
        run: { command, args: ["lsp"], transport: TransportKind.stdio, options: { env } },
        debug: { command, args: ["lsp"], transport: TransportKind.stdio, options: { env } }
    };
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: "file", language: "larimar" }],
        outputChannel: output,
        synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/{*.lar,larimar.toml}") }
    };
    client = new LanguageClient("larimar", "Larimar", serverOptions, clientOptions);
    try {
        await client.start();
    } catch (e) {
        output.appendLine(`The language server did not start: ${e}`);
        vscode.window.showErrorMessage(`Larimar: the language server (${command} lsp) did not start. See Output > Larimar.`);
        client = undefined;
    }
}

async function stopServer(): Promise<void> {
    if (!client) { return; }
    const c = client;
    client = undefined;
    try { await c.stop(); } catch { /* it may have ended already */ }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/** The folder of the project of the current file (the nearest larimar.toml above it). */
function projectFolder(): string | undefined {
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    let dir = file ? path.dirname(file) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    while (dir) {
        if (fs.existsSync(path.join(dir, "larimar.toml"))) { return dir; }
        const up = path.dirname(dir);
        if (up === dir) { break; }
        dir = up;
    }
    return undefined;
}

function quote(s: string): string {
    return process.platform === "win32" ? `"${s}"` : `'${s.replace(/'/g, "'\\''")}'`;
}

async function runInTerminal(what: "run" | "build" | "check"): Promise<void> {
    const home = findHome();
    if (!home) {
        vscode.window.showWarningMessage("Larimar was not found (LARIMAR_HOME or larimar.home).");
        return;
    }
    const folder = projectFolder();
    const file = vscode.window.activeTextEditor?.document;
    if (file?.isDirty) { await file.save(); }
    let target: string;
    if (folder) {
        target = quote(folder);
    } else if (what === "check" && file?.languageId === "larimar") {
        target = quote(file.uri.fsPath);
    } else {
        vscode.window.showWarningMessage("No larimar.toml above this file: larimar run and build work on projects (larimar new <name>).");
        return;
    }
    if (!terminal) {
        terminal = vscode.window.createTerminal({ name: "Larimar", env: { LARIMAR_HOME: home } });
    }
    terminal.show(true);
    terminal.sendText(`${quote(path.join(home, "bin", EXE))} ${what} ${target}`);
}

async function showGeneratedC(): Promise<void> {
    const home = findHome();
    const doc = vscode.window.activeTextEditor?.document;
    if (!home || !doc || doc.languageId !== "larimar") { return; }
    if (doc.isDirty) { await doc.save(); }
    cp.execFile(path.join(home, "bin", EXE), ["c", doc.uri.fsPath], {
        env: { ...process.env, LARIMAR_HOME: home },
        cwd: path.dirname(doc.uri.fsPath),
        maxBuffer: 64 * 1024 * 1024
    }, async (err, stdout, stderr) => {
        if (err && !stdout) {
            vscode.window.showErrorMessage(`Larimar: ${stderr || err.message}`);
            return;
        }
        const c = await vscode.workspace.openTextDocument({ language: "c", content: stdout });
        await vscode.window.showTextDocument(c, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    });
}

// ---------------------------------------------------------------------------------------------
// Debugging
// ---------------------------------------------------------------------------------------------

const CODELLDB = "vadimcn.vscode-lldb";
const CPPTOOLS = "ms-vscode.cpptools";

type DebuggerKind = "larimar" | "codelldb" | "gdb" | "lldb-mi";

/** What larimar.toml says about where the build goes: the executable and the debug map. */
function projectOutputs(folder: string): { program: string; debugMap: string } | undefined {
    let text: string;
    try { text = fs.readFileSync(path.join(folder, "larimar.toml"), "utf8"); } catch { return undefined; }
    let section = "";
    let name = "";
    let output = "";
    let buildDir = "build";
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, "").trim();
        const head = /^\[([^\]]+)\]$/.exec(line);
        if (head) { section = head[1].trim(); continue; }
        const kv = /^([A-Za-z_]+)\s*=\s*"([^"]*)"/.exec(line);
        if (!kv || section !== "project") { continue; }
        if (kv[1] === "name") { name = kv[2]; }
        if (kv[1] === "output") { output = kv[2]; }
        if (kv[1] === "build_dir") { buildDir = kv[2]; }
    }
    if (!name) { return undefined; }
    let program = path.resolve(folder, output || path.join(buildDir, name));
    if (process.platform === "win32" && !program.toLowerCase().endsWith(".exe")) { program += ".exe"; }
    return { program, debugMap: path.resolve(folder, buildDir, `${name}.debug.json`) };
}

/** larimar build --debug; true when it built. */
function buildDebug(home: string, folder: string): Promise<boolean> {
    return new Promise((resolve) => {
        output.appendLine(`> larimar build --debug ${folder}`);
        const child = cp.spawn(path.join(home, "bin", EXE), ["build", "--debug", folder], {
            env: { ...process.env, LARIMAR_HOME: home },
            cwd: folder
        });
        child.stdout.on("data", (d) => output.append(d.toString()));
        child.stderr.on("data", (d) => output.append(d.toString()));
        child.on("error", (e) => { output.appendLine(String(e)); resolve(false); });
        child.on("close", (code) => resolve(code === 0));
    });
}

function whichDebugger(config: vscode.DebugConfiguration): DebuggerKind {
    const choice: string = config.debugger || vscode.workspace.getConfiguration("larimar").get<string>("debugger", "larimar");
    return (choice === "auto" ? "larimar" : choice) as DebuggerKind;
}

/** lldb-dap for larimar dap: the larimar.lldbDap setting, or Xcode's on macOS (xcrun); "" lets larimar dap look. */
function lldbDapPath(): string {
    const configured = vscode.workspace.getConfiguration("larimar").get<string>("lldbDap", "").trim();
    if (configured) { return expandHome(configured); }
    if (process.platform === "darwin") {
        try {
            const found = cp.execFileSync("xcrun", ["--find", "lldb-dap"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
            if (found && fs.existsSync(found)) { return found; }
        } catch { /* older Xcode: larimar dap looks on the PATH and in Homebrew's LLVM */ }
    }
    return "";
}

/** Starts larimar dap (the debugger written in Larimar) for "larimar" sessions. */
class LarimarDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        const home = findHome();
        if (!home) {
            vscode.window.showErrorMessage("Larimar was not found: set LARIMAR_HOME or the larimar.home setting.");
            return undefined;
        }
        const args = ["dap"];
        const backend = lldbDapPath();
        if (backend) { args.push("--backend", backend); }
        output.appendLine(`> larimar ${args.join(" ")}`);
        return new vscode.DebugAdapterExecutable(path.join(home, "bin", EXE), args, { env: { ...process.env, LARIMAR_HOME: home } });
    }
}

class LarimarDebugProvider implements vscode.DebugConfigurationProvider {
    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return [{ type: "larimar", request: "launch", name: "Debug Larimar project", project: "${workspaceFolder}", args: [] }];
    }

    async resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined,
                                    config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
        if (!config.type && !config.request) {            // F5 without a launch.json
            if (vscode.window.activeTextEditor?.document.languageId !== "larimar") { return config; }
            config = { type: "larimar", request: "launch", name: "Debug Larimar project" };
        }
        if (config.program && config.debugMap) { return config; }      // already resolved (a restart)
        const home = findHome();
        if (!home) {
            vscode.window.showErrorMessage("Larimar was not found: set LARIMAR_HOME or the larimar.home setting.");
            return undefined;
        }
        const folder = config.project ? path.resolve(config.project) : projectFolder();
        if (!folder || !fs.existsSync(path.join(folder, "larimar.toml"))) {
            vscode.window.showErrorMessage("Debugging needs a project: no larimar.toml above this file (larimar new <name> creates one).");
            return undefined;
        }
        const kind = whichDebugger(config);
        if (kind !== "larimar") {
            const needed = kind === "codelldb" ? CODELLDB : CPPTOOLS;
            if (!vscode.extensions.getExtension(needed)) {
                const choice = await vscode.window.showErrorMessage(`The debugger "${kind}" needs the extension ${needed}.`, "Install");
                if (choice) { await vscode.commands.executeCommand("workbench.extensions.installExtension", needed); }
                return undefined;
            }
        }

        await vscode.workspace.saveAll(false);
        const built = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: "Larimar: building for the debugger" },
            () => buildDebug(home, folder));
        if (!built) {
            output.show(true);
            vscode.window.showErrorMessage("Larimar: the build failed (see Output > Larimar).");
            return undefined;
        }
        const outputs = projectOutputs(folder);
        if (!outputs || !fs.existsSync(outputs.program)) {
            vscode.window.showErrorMessage(`Larimar: the executable was not found (${outputs?.program ?? "larimar.toml has no name"}).`);
            return undefined;
        }
        const program = outputs.program;
        const args: string[] = config.args ?? [];
        const cwd: string = config.cwd ?? folder;
        const env: { [k: string]: string } = config.env ?? {};
        const name: string = config.name ?? "Debug Larimar project";
        const debugDir = path.join(home, "debug");

        if (kind === "larimar") {
            return {
                type: "larimar", request: "launch", name, program, debugMap: outputs.debugMap, args, cwd, env,
                stopOnEntry: !!config.stopOnEntry, console: config.console ?? "debugConsole"
            };
        }
        if (kind === "codelldb") {
            return {
                type: "lldb", request: "launch", name, program, args, cwd, env,
                terminal: "integrated",
                initCommands: [`command script import "${path.join(debugDir, "larimar_lldb.py")}"`],
                // stop at the start of the Larimar main (the C main is the generated wrapper)
                preRunCommands: config.stopOnEntry ? ["breakpoint set --one-shot true --name user_main"] : []
            };
        }
        const environment = Object.keys(env).map((k) => ({ name: k, value: env[k] }));
        const setupCommands = [{ description: "pretty printing", text: "-enable-pretty-printing", ignoreFailures: true }];
        if (kind === "gdb") {
            setupCommands.push({ description: "Larimar values", text: `source ${path.join(debugDir, "larimar_gdb.py")}`, ignoreFailures: true });
        }
        return {
            type: "cppdbg", request: "launch", name, program, args, cwd, environment,
            stopAtEntry: !!config.stopOnEntry,
            MIMode: kind === "gdb" ? "gdb" : "lldb",
            setupCommands
        };
    }
}


/**
 * Indents Larimar code: braces, brackets and parentheses, #when blocks, and `wait until` / `throws`
 * continuing a signature (two levels in). Only the indentation changes; text blocks (""") and the
 * #when / #else / #end lines stay as written (their column decides the nesting).
 */
export function indentLarimar(lines: string[], unit: string): string[] {
  const out: string[] = [];
  let depth = 0;                 // braces, brackets and parentheses open
  let inComment = false;         // inside /* ... */
  let inText = false;            // inside a """ text block
  const whens: number[] = [];    // the columns of the open #when
  for (const raw of lines) {
    const text = raw.trim();
    if (inText) { out.push(raw); if (text.includes('"""')) { inText = false; } continue; }
    if (/^#(when|else|end)\b/.test(text)) {
      const col = raw.length - raw.trimStart().length;
      if (text.startsWith('#when') && whens[whens.length - 1] !== col) { whens.push(col); }
      if (text.startsWith('#end')) { whens.pop(); }
      out.push(raw.trimEnd());
      continue;
    }
    if (text === '') { out.push(''); continue; }
    if (inComment) { out.push(raw.trimEnd()); }
    let lead = 0;                                        // closers at the start go one level out
    for (const ch of text) { if ('}])'.includes(ch)) { lead++; } else { break; } }
    const level = Math.max(0, depth - lead) + whens.length
                + (/^(wait until|throws)\b/.test(text) ? 2 : 0);   // continuation of a signature
    if (!inComment) { out.push(unit.repeat(level) + text); }
    for (let j = 0; j < text.length; j++) {             // what opens and closes, outside texts and comments
      const c = text[j], n = text[j + 1];
      if (inComment) { if (c === '*' && n === '/') { inComment = false; j++; } continue; }
      if (c === '/' && n === '/') { break; }
      if (c === '/' && n === '*') { inComment = true; j++; continue; }
      if (text.startsWith('"""', j)) { if (text.indexOf('"""', j + 3) < 0) { inText = true; } break; }
      if (c === '"' || c === "'") {
        j++;
        while (j < text.length && text[j] !== c) { if (text[j] === '\\') { j++; } j++; }
        continue;
      }
      if ('{[('.includes(c)) { depth++; } else if ('}])'.includes(c)) { depth--; }
    }
    depth = Math.max(0, depth);
  }
  return out;
}

/** Format Document (Shift+Alt+F, or on save with editor.formatOnSave) for .lar files. */
function registerFormatter(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider('larimar', {
    provideDocumentFormattingEdits(doc, options) {
      const unit = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
      const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const before = doc.getText();
      const after = indentLarimar(before.split(/\r?\n/), unit).join(eol);
      if (after === before) { return []; }
      const all = new vscode.Range(doc.positionAt(0), doc.positionAt(before.length));
      return [vscode.TextEdit.replace(all, after)];
    }
  }));
}
