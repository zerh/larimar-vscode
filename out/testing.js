"use strict";
// The tests of a Larimar project in VS Code's Testing view. Everything comes from `larimarc test`:
//
//   larimarc test --list --json                     the tests (one {"event": "found", ...} per line)
//   larimarc test --json <file> [--test <name>]...  runs them ({"event": "result", ...}, then "summary")
//
// A file with test functions shows each of them; a file that says what it expects (`// expect: run`)
// is one test. They run in the folder of the project (its larimar.toml), like `larimar test` there.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTests = registerTests;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const cp = __importStar(require("child_process"));
const vscode = __importStar(require("vscode"));
const EXE = process.platform === "win32" ? "larimarc.exe" : "larimarc";
function registerTests(context, findHome, output) {
    const controller = vscode.tests.createTestController("larimar", "Larimar");
    context.subscriptions.push(controller);
    const entries = new WeakMap();
    /** The folders with a larimar.toml (build/ and deps/ are not projects). */
    async function projects() {
        const found = await vscode.workspace.findFiles("**/larimar.toml", "**/{build,deps,node_modules,out}/**");
        return found.map((u) => path.dirname(u.fsPath)).sort();
    }
    async function discover() {
        const home = findHome();
        if (!home) {
            return;
        }
        const items = [];
        for (const project of await projects()) {
            const events = await larimarc(home, project, ["test", "--list", "--json"]);
            const files = new Map();
            for (const e of events) {
                if (e.event !== "found" || !e.path || !e.file) {
                    continue;
                }
                let file = files.get(e.path);
                if (!file) {
                    file = controller.createTestItem(e.path, e.file, vscode.Uri.file(e.path));
                    entries.set(file, { project, file: e.path, name: "" });
                    files.set(e.path, file);
                    items.push(file);
                }
                if (e.name) {
                    const test = controller.createTestItem(`${e.path}::${e.name}`, e.name, vscode.Uri.file(e.path));
                    const line = Math.max(0, (e.line ?? 1) - 1);
                    test.range = new vscode.Range(line, 0, line, 0);
                    entries.set(test, { project, file: e.path, name: e.name });
                    file.children.add(test);
                }
                else {
                    file.range = new vscode.Range(0, 0, 0, 0);
                }
            }
        }
        controller.items.replace(items);
    }
    controller.refreshHandler = () => discover();
    // when a .lar file changes, the tests are listed again (once, after a second of quiet)
    let timer;
    const later = () => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => { discover().catch((err) => output.appendLine(`tests: ${err}`)); }, 1000);
    };
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.lar");
    context.subscriptions.push(watcher, watcher.onDidChange(later), watcher.onDidCreate(later), watcher.onDidDelete(later));
    controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, async (request, token) => {
        const home = findHome();
        const run = controller.createTestRun(request);
        if (!home) {
            run.appendOutput("Larimar was not found: set LARIMAR_HOME or the larimar.home setting.\r\n");
            run.end();
            return;
        }
        // what to run, file by file: the whole file, or some of its tests by name
        const wanted = [];
        if (request.include) {
            wanted.push(...request.include);
        }
        else {
            controller.items.forEach((i) => wanted.push(i));
        }
        const excluded = new Set(request.exclude ?? []);
        const byFile = new Map();
        for (const item of wanted) {
            const entry = entries.get(item);
            if (!entry || excluded.has(item)) {
                continue;
            }
            let group = byFile.get(entry.file);
            if (!group) {
                group = { entry, names: [], items: [] };
                byFile.set(entry.file, group);
            }
            if (entry.name === "") { // a file: its tests (without the excluded ones), or itself
                const children = [];
                item.children.forEach((c) => { if (!excluded.has(c)) {
                    children.push(c);
                } });
                if (children.length === 0) {
                    group.items.push(item);
                }
                else {
                    for (const c of children) {
                        group.names.push(entries.get(c).name);
                        group.items.push(c);
                    }
                }
            }
            else {
                group.names.push(entry.name);
                group.items.push(item);
            }
        }
        for (const group of byFile.values()) {
            if (token.isCancellationRequested) {
                break;
            }
            for (const item of group.items) {
                run.started(item);
            }
            const pending = new Set(group.items);
            const args = ["test", "--json", group.entry.file];
            // the whole file when every test of it was asked for, else each by its name
            const file = controller.items.get(group.entry.file);
            const all = file !== undefined && file.children.size > 0 && group.names.length === file.children.size;
            if (!all) {
                for (const n of group.names) {
                    args.push("--test", n);
                }
            }
            const events = await larimarc(home, group.entry.project, args, token, (text) => run.appendOutput(text.replace(/\n/g, "\r\n")));
            for (const e of events) {
                if (e.event !== "result" || !e.path) {
                    continue;
                }
                const item = e.name ? file?.children.get(`${e.path}::${e.name}`) : file;
                if (!item) {
                    continue;
                }
                pending.delete(item);
                if (e.result === "passed") {
                    run.passed(item);
                }
                else if (e.result === "skipped") {
                    run.skipped(item);
                    if (e.message) {
                        run.appendOutput(`skipped ${e.name || e.file}: ${e.message}\r\n`, undefined, item);
                    }
                }
                else {
                    const message = new vscode.TestMessage(e.message || "failed");
                    if (item.uri && item.range) {
                        message.location = new vscode.Location(item.uri, item.range);
                    }
                    run.failed(item, message);
                }
            }
            for (const item of pending) {
                run.errored(item, new vscode.TestMessage(token.isCancellationRequested ? "cancelled" : "larimar test gave no result for it (see the output)"));
            }
        }
        run.end();
    }, true);
    discover().catch((err) => output.appendLine(`tests: ${err}`));
}
/**
 * Runs larimarc in a project and gives the JSON lines it wrote. What is not JSON (a crash, a message of
 * the compiler) goes to `echo`, so it shows in the output of the run.
 */
function larimarc(home, project, args, token, echo) {
    return new Promise((resolve) => {
        const exe = path.join(home, "bin", EXE);
        if (!fs.existsSync(exe)) {
            echo?.(`${exe} does not exist\n`);
            resolve([]);
            return;
        }
        const child = cp.spawn(exe, args, { cwd: project, env: { ...process.env, LARIMAR_HOME: home } });
        const events = [];
        let rest = "";
        const take = (chunk) => {
            rest += chunk;
            let nl = rest.indexOf("\n");
            while (nl >= 0) {
                const line = rest.substring(0, nl).trim();
                rest = rest.substring(nl + 1);
                if (line.startsWith("{")) {
                    try {
                        events.push(JSON.parse(line));
                    }
                    catch {
                        echo?.(line + "\n");
                    }
                }
                else if (line !== "") {
                    echo?.(line + "\n");
                }
                nl = rest.indexOf("\n");
            }
        };
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", take);
        child.stderr.on("data", (text) => echo?.(text));
        const cancel = token?.onCancellationRequested(() => child.kill());
        child.on("error", (err) => echo?.(`${err}\n`));
        child.on("close", () => {
            take("\n");
            cancel?.dispose();
            resolve(events);
        });
    });
}
//# sourceMappingURL=testing.js.map