// Windows setup driver. Run setup.ps1 to also install missing prerequisites.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = dirname(fileURLToPath(import.meta.url));
const BRANCHES = { stable: "Discord", canary: "DiscordCanary", ptb: "DiscordPTB" };
const PLUGINS = ["ActivityTracker", "AudioPlayerAPI", "ClientModDetector", "FakeDeafen", "FakeMedia", "GoLiveBypass", "LastMessageDate", "LastOnlineTracker", "ToastNotifications", "VoiceChannelFinder", "VoiceChannelLog", "VoiceFakeDetector"];
const TESTS = ["testVoiceChannelHistory.mjs", "testUserplugins.mjs", "testActivityTracker.mjs", "testToastVoiceTracking.mjs", "testGoLive.mjs", "testDiscordCompatibility.mjs"];

function run(command, args, cwd, capture = false, extraEnv = {}) {
    const result = spawnSync(command, args, {
        cwd, windowsHide: true, shell: false,
        encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
        env: { ...process.env, ...extraEnv },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed (${result.status}).${capture ? `\n${result.stderr?.trim() ?? ""}` : ""}`);
    return result.stdout?.trim() ?? "";
}

export function readLoaderTarget(loader) {
    if (!existsSync(loader)) return null;
    let text;
    if (statSync(loader).isDirectory()) {
        const entry = join(loader, "index.js");
        if (!existsSync(entry)) return null;
        text = readFileSync(entry, "utf8");
    } else {
        if (statSync(loader).size > 128 * 1024) return null;
        text = readFileSync(loader).toString("utf8");
    }
    const literal = /\brequire\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)/.exec(text)?.[1];
    if (!literal) return null;
    try {
        return literal.startsWith('"') ? JSON.parse(literal) : literal.slice(1, -1).replace(/\\(['\\])/g, "$1");
    } catch {
        return null;
    }
}

export function inspectDiscord(root, channel = "custom") {
    if (!existsSync(root) || !statSync(root).isDirectory()) return null;
    const versions = readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^app-\d+(?:\.\d+)*$/.test(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => {
            const x = a.slice(4).split(".").map(Number), y = b.slice(4).split(".").map(Number);
            for (let i = 0; i < Math.max(x.length, y.length); i++) {
                if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
            }
            return 0;
        });
    for (const version of versions) {
        const resources = join(root, version, "resources");
        if (!existsSync(join(resources, "app.asar"))) continue;
        const loaderTarget = readLoaderTarget(join(resources, "app.asar"));
        const kind = !loaderTarget ? "standard Discord"
            : /(?:^|[\\/])equicord\.asar$/i.test(loaderTarget) ? "Equicord installed with the .exe"
                : /[\\/]dist[\\/]desktop(?:[\\/](?:patcher\.js|index\.js))?[\\/]?$/i.test(loaderTarget) ? "Equicord source build"
                    : "existing client loader";
        if (channel === "custom") channel = Object.entries(BRANCHES).find(([, name]) => existsSync(join(root, version, `${name}.exe`)))?.[0] ?? channel;
        const executable = join(root, version, `${BRANCHES[channel] ?? "Discord"}.exe`);
        return { root: resolve(root), channel, resources, loaderTarget, kind, executable };
    }
    return null;
}

export function detectDiscords(localAppData, customPath) {
    if (customPath) {
        let root = resolve(customPath);
        if (existsSync(root) && statSync(root).isFile()) root = dirname(root);
        if (/^app-\d/.test(root.split(/[\\/]/).at(-1))) root = dirname(root);
        return [inspectDiscord(root)].filter(Boolean);
    }
    return Object.entries(BRANCHES).map(([channel, name]) => inspectDiscord(join(localAppData, name), channel)).filter(Boolean);
}

export function mergeSetupSettings(current, saved) {
    if (!current || typeof current !== "object" || Array.isArray(current)
        || current.plugins != null && (typeof current.plugins !== "object" || Array.isArray(current.plugins))) throw new Error("The existing settings file is invalid. Fix it before applying setup.");
    const plugins = { ...current.plugins };
    for (const name of PLUGINS) {
        const options = { ...saved.plugins?.[name] };
        if (name === "GoLiveBypass") {
            for (const key of ["goLive", "gatewayProxy", "onboardingCompleted", "onboardingSkipped"]) delete options[key];
        }
        plugins[name] = { ...options, ...plugins[name], enabled: true };
    }
    plugins.ActivityTracker.autoRefreshProfiles ??= false;
    return { ...current, autoUpdate: false, plugins };
}

export function backupInstallation(discord, settingsDirectory, backupRoot) {
    mkdirSync(backupRoot, { recursive: true });
    const backup = mkdtempSync(join(backupRoot, "setup-"));
    for (const name of ["app.asar", "_app.asar"]) {
        const source = join(discord.resources, name);
        if (existsSync(source)) cpSync(source, join(backup, name), { recursive: true });
    }
    if (existsSync(settingsDirectory)) cpSync(settingsDirectory, join(backup, "settings"), { recursive: true });
    writeFileSync(join(backup, "installation.private.json"), JSON.stringify({ ...discord, settingsDirectory }, null, 2));
    return backup;
}

export function restoreLoader(resources, backup) {
    for (const name of ["app.asar", "_app.asar"]) {
        const target = resolve(resources, name);
        if (dirname(target) !== resolve(resources)) throw new Error("Invalid restore destination.");
        rmSync(target, { recursive: true, force: true });
        const original = join(backup, name);
        if (existsSync(original)) cpSync(original, target, { recursive: true });
    }
}

function writeSettings(settingsFile, settings) {
    mkdirSync(dirname(settingsFile), { recursive: true });
    const temporary = `${settingsFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(settings, null, 4));
    renameSync(temporary, settingsFile);
}

export function verifyInjection(resources, build) {
    const injected = readLoaderTarget(join(resources, "app.asar"));
    const expected = resolve(build, "dist/desktop");
    return !!injected && isAbsolute(injected)
        && [expected, join(expected, "patcher.js")].some(target => resolve(injected).toLowerCase() === target.toLowerCase())
        && existsSync(join(resources, "_app.asar"));
}

function npmCli() {
    const filename = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    if (!existsSync(filename)) throw new Error("npm was not found beside Node.js. Reinstall Node.js LTS and rerun setup.ps1.");
    return filename;
}

function acquireLock(root) {
    const lockFile = join(root, "setup.lock");
    if (existsSync(lockFile)) {
        let running = true;
        const pid = Number(readFileSync(lockFile, "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("The setup lock is invalid. Check that another setup is not running, then remove setup.lock.");
        try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") running = false; }
        if (running) throw new Error("Another setup is already running.");
        rmSync(lockFile);
    }
    const lock = openSync(lockFile, "wx");
    writeFileSync(lock, String(process.pid));
    closeSync(lock);
    return () => { if (readFileSync(lockFile, "utf8") === String(process.pid)) rmSync(lockFile); };
}

function parseArguments(args) {
    const options = { channel: "auto", root: join(process.env.LOCALAPPDATA ?? "", "EquicordImprovements") };
    const values = new Set(["--root", "--channel", "--discord-path"]);
    const switches = new Set(["--prepare-only", "--detect-only", "--no-launch", "--yes", "--help"]);
    for (let index = 0; index < args.length; index++) {
        const key = args[index];
        if (switches.has(key)) options[key.slice(2)] = true;
        else if (values.has(key) && args[index + 1] && !args[index + 1].startsWith("--")) options[key.slice(2)] = args[++index];
        else throw new Error(`Unknown or incomplete option: ${key}`);
    }
    if (!["auto", ...Object.keys(BRANCHES)].includes(options.channel)) throw new Error("Channel must be auto, stable, canary or ptb.");
    return options;
}

async function confirmClosure(discord, unattended) {
    if (unattended) return;
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await input.question(`Ready to apply the build to Discord (${discord.channel})? Discord will close and leave any active call. [Y/n] `);
        if (answer && !/^y(?:es)?$/i.test(answer.trim())) throw new Error("Setup stopped before changing Discord. The prepared build can be used next time.");
    } finally {
        input.close();
    }
}

function stopDiscord(discord) {
    const processName = BRANCHES[discord.channel] ?? "Discord";
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Process -Name $env:EQUICORD_SETUP_PROCESS -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Milliseconds 500; if(Get-Process -Name $env:EQUICORD_SETUP_PROCESS -ErrorAction SilentlyContinue){exit 1}; exit 0"], undefined, false, { EQUICORD_SETUP_PROCESS: processName });
}

export async function main(args = process.argv.slice(2)) {
    const options = parseArguments(args);
    if (options.help) {
        console.log("node setup.mjs [--root PATH] [--channel auto|stable|canary|ptb] [--discord-path PATH] [--detect-only] [--prepare-only] [--no-launch] [--yes]");
        return;
    }
    if (process.platform !== "win32") throw new Error("This setup supports Windows. Use install.mjs for other platforms.");
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || major === 22 && minor < 12) throw new Error("Node.js 22.12 or newer is required. Run setup.ps1 to install Node.js LTS.");
    const discords = detectDiscords(process.env.LOCALAPPDATA, options["discord-path"]);
    for (const discord of discords) {
        console.log(`Found ${discord.channel}: ${discord.kind}`);
        console.log(`  Discord: ${discord.root}`);
        if (discord.loaderTarget) console.log(`  Current loader: ${discord.loaderTarget}`);
    }
    const existingPackage = join(process.env.APPDATA, "Equicord/equicord.asar");
    if (existsSync(existingPackage)) console.log("An Equicord .exe installation package is also present in AppData.");
    if (options["detect-only"]) return;
    const discord = options["discord-path"] ? discords[0] : discords.find(item => options.channel === "auto" || item.channel === options.channel);
    if (!discord && !options["prepare-only"]) throw new Error("Discord was not found. Install and open Discord once, or use --discord-path.");

    const root = resolve(options.root);
    mkdirSync(root, { recursive: true });
    const releaseLock = acquireLock(root);
    try {
        const upstream = join(root, "upstream");
        if (!existsSync(upstream)) run("git.exe", ["clone", "--depth", "1", "--branch", "main", "https://github.com/Equicord/Equicord.git", upstream]);
        else {
            if (run("git.exe", ["remote", "get-url", "origin"], upstream, true) !== "https://github.com/Equicord/Equicord.git") throw new Error("The managed upstream folder points to a different repository.");
            run("git.exe", ["fetch", "--depth", "1", "origin", "main"], upstream);
        }
        const upstreamCommit = run("git.exe", ["rev-parse", "origin/main"], upstream, true);
        const improvementsCommit = run("git.exe", ["rev-parse", "HEAD"], REPOSITORY, true);
        const builds = join(root, "builds");
        mkdirSync(builds, { recursive: true });
        const build = mkdtempSync(join(builds, `${upstreamCommit.slice(0, 8)}-${improvementsCommit.slice(0, 8)}-`));
        run("git.exe", ["worktree", "add", "--detach", build, upstreamCommit], upstream);
        console.log(`Building current Equicord ${upstreamCommit.slice(0, 8)} in ${build}`);

        const manifest = JSON.parse(readFileSync(join(build, "package.json"), "utf8"));
        const version = /^pnpm@(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\+.*)?$/.exec(manifest.packageManager)?.[1];
        if (!version) throw new Error("Equicord did not specify an exact pnpm version.");
        const packageManager = (...command) => run(process.execPath, [npmCli(), "exec", "--yes", `--package=pnpm@${version}`, "--", "pnpm", ...command], build);
        packageManager("install", "--frozen-lockfile");
        run(process.execPath, [join(REPOSITORY, "install.mjs"), build], REPOSITORY);
        packageManager("exec", "tsc", "--noEmit");
        for (const test of TESTS) run(process.execPath, [join(build, "scripts", test)], build);
        packageManager("build");
        for (const name of ["patcher.js", "renderer.js", "preload.js", "package.json"]) {
            if (!existsSync(join(build, "dist/desktop", name))) throw new Error(`The build is missing ${name}.`);
        }
        if (options["prepare-only"]) {
            console.log(`Build and all checks passed. Prepared source: ${build}`);
            return;
        }

        await confirmClosure(discord, options.yes);
        stopDiscord(discord);
        const selected = inspectDiscord(discord.root, discord.channel);
        if (!selected) throw new Error("Discord changed during setup. Rerun the setup.");
        const dataDirectory = process.env.EQUICORD_USER_DATA_DIR ?? (process.env.DISCORD_USER_DATA_DIR
            ? join(process.env.DISCORD_USER_DATA_DIR, "..", "EquicordData") : join(process.env.APPDATA, "Equicord"));
        const settingsDirectory = join(dataDirectory, "settings");
        const settingsFile = join(settingsDirectory, "settings.json");
        const originalSettings = existsSync(settingsFile) ? readFileSync(settingsFile) : null;
        const current = originalSettings ? JSON.parse(originalSettings.toString("utf8")) : {};
        const saved = JSON.parse(readFileSync(join(REPOSITORY, "settings/settings.public.json"), "utf8"));
        const backup = backupInstallation(selected, settingsDirectory, join(root, "backups"));
        console.log(`Backup saved in ${backup}`);
        try {
            run(process.execPath, [join(build, "scripts/runInstaller.mjs"), "--", "--install", "--location", selected.root], build);
            if (!verifyInjection(selected.resources, build)) throw new Error("The official installer did not confirm the expected injection.");
            writeSettings(settingsFile, mergeSetupSettings(current, saved));
        } catch (error) {
            restoreLoader(selected.resources, backup);
            if (originalSettings) writeFileSync(settingsFile, originalSettings);
            else if (existsSync(settingsFile)) rmSync(settingsFile);
            throw new Error(`Setup failed; the previous Discord loader was restored. Backup: ${backup}`, { cause: error });
        }
        writeFileSync(join(root, "setup-state.private.json"), JSON.stringify({ upstreamCommit, improvementsCommit, source: build, channel: selected.channel, discordRoot: selected.root, backup, completedAt: new Date().toISOString() }, null, 2));
        console.log("Installed and verified. The bundled plugins are enabled. GoLiveBypass account and route setup is available inside Discord.");
        console.log(`Keep this source folder: ${build}`);
        if (!options["no-launch"] && existsSync(selected.executable)) {
            const child = spawn(selected.executable, [], { detached: true, stdio: "ignore", windowsHide: false });
            child.on("error", error => console.error(`Open Discord manually: ${error.message}`));
            child.unref();
        }
    } finally {
        releaseLock();
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => {
        console.error(`\nSetup failed: ${error.message}`);
        if (error.cause) console.error(error.cause.message);
        process.exitCode = 1;
    });
}
