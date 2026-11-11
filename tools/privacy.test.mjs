import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkRepository, collectPrivateIds, sanitizeSettings } from "./privacy.mjs";

const ID = "222222222222222222";

const clean = sanitizeSettings({
    autoUpdate: true,
    themeLinks: ["https://example.com/theme.css"],
    cloud: { url: "https://cloud", authenticated: true },
    windowsMaterial: "none",
    plugins: {
        Zed: { enabled: true, timeout: 6, opacity: 0.5 },
        Toast: { enabled: true, trackedVoiceUsers: `${ID} 1`, newField: ID, nested: { id: ID }, list: [ID], bigNumber: Number(ID) },
        Broken: null
    }
});

assert.deepEqual(clean, {
    autoUpdate: true,
    plugins: { Toast: { enabled: true }, Zed: { enabled: true, timeout: 6, opacity: 0.5 } }
}, "Only booleans and small numbers pass");
assert.ok(!JSON.stringify(clean).includes(ID));
assert.equal(Object.keys(clean.plugins)[0], "Toast", "A stable order keeps Git diffs clean");

assert.deepEqual(sanitizeSettings({ plugins: { GoLiveBypass: {
    enabled: true, autoUpdate: false, protonFreeOnly: true,
    goLive: true, gatewayProxy: true, onboardingCompleted: true, onboardingSkipped: true,
} } }).plugins.GoLiveBypass, { enabled: true, autoUpdate: false, protonFreeOnly: true }, "Installing public options preserves the new user's own setup and tunnel choice");

const root = mkdtempSync(join(tmpdir(), "repo-"));
mkdirSync(join(root, "src"));
mkdirSync(join(root, "settings"));

const check = (name, content, ids = new Set()) => {
    const file = join(root, name);
    writeFileSync(file, content);
    const problems = checkRepository(root, ids);
    writeFileSync(file, "");
    return problems.join(" ");
};

assert.equal(check("src/ok.ts", "authors: [{ id: 1128391811136770128n }]"), "", "A public author ID passes");
assert.match(check("src/a.ts", `tracked = "${ID}"`, new Set([ID])), /real Discord ID/, "A real ID blocks in any file");
assert.match(check("src/a.ts", `id: ${ID}n`, new Set([ID])), /real Discord ID/, "A BigInt ID blocks too");
assert.match(check("settings/a.json", '{"x":"111111111111111111"}'), /ID in settings/, "Any ID blocks in settings");
assert.match(check("src/b.ts", "C:\\Users\\someone\\Documents"), /personal path/);
assert.match(check("src/c.ts", "/home/someone/dev"), /personal path/);
assert.match(check("src/d.ts", "someone@gmail.com"), /email address/);
assert.match(check("src/e.ts", `token = "ghp_${"a".repeat(36)}"`), /GitHub token/);
assert.match(check("src/f.ts", `t = "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAx.GaBcDe.${"a".repeat(27)}"`), /Discord token/);
assert.match(check("data.jsonl", "{}"), /forbidden file/);

assert.equal(collectPrivateIds(`{"a":"${ID}"}`, ["123456789012345678"]).size, 2);
console.log("Privacy filter passed.");
