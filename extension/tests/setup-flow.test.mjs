import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  FIRST_SHOW_DELAY_MS, SETTLE_MS, decideView, defaultFolder, detectOs, folderHint, isDeployed, macInstallCommand, macInstallUrl,
  selfCheckItems, stepStates,
} from "../lib/setup-flow.js";

test("the one-line Mac command fetches the installer from the repository's main branch and hands it to bash", () => {
  assert.equal(macInstallUrl(), "https://raw.githubusercontent.com/unnn3ing-oss/videodownload/main/extension/installers/install-mac.sh");
  assert.equal(macInstallCommand(), "curl -fsSL https://raw.githubusercontent.com/unnn3ing-oss/videodownload/main/extension/installers/install-mac.sh | bash");
});

test("the command follows the configured repository, and refuses anything that would need shell quoting", () => {
  assert.equal(macInstallUrl({ owner: "o-1", repo: "r.x", branch: "release_2" }),
    "https://raw.githubusercontent.com/o-1/r.x/release_2/extension/installers/install-mac.sh");
  for (const bad of [{ owner: "a b", repo: "r", branch: "main" }, { owner: "o", repo: "r;rm -rf ~", branch: "main" },
    { owner: "o", repo: "r", branch: "main$(x)" }, { owner: "", repo: "r", branch: "main" }, { owner: "o", repo: "r", branch: "a/../b" }]) {
    assert.throws(() => macInstallCommand(bad), /repository/, JSON.stringify(bad));
  }
});

test("the file that the command downloads is in the repository", () => {
  assert.ok(existsSync(new URL("../installers/install-mac.sh", import.meta.url)));
});

// ---------------- which computer, and the folder to suggest ----------------

test("detectOs tells a Mac, a Windows PC and anything else apart", () => {
  assert.equal(detectOs({ userAgentData: { platform: "macOS" }, platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }), "mac");
  assert.equal(detectOs({ platform: "MacIntel", userAgent: "x" }), "mac");
  assert.equal(detectOs({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" }), "mac");
  assert.equal(detectOs({ userAgentData: { platform: "Windows" }, platform: "Win32" }), "win");
  assert.equal(detectOs({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }), "win");
  assert.equal(detectOs({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "other");
  assert.equal(detectOs({}), "other");
  assert.equal(detectOs(undefined), "other");
});

test("the suggested folder for the extension is the same place every time, written the way each system understands", () => {
  assert.equal(defaultFolder("mac"), "~/YT批量下載器擴充功能");
  assert.equal(defaultFolder("win"), "%USERPROFILE%\\YT批量下載器擴充功能");
  assert.equal(defaultFolder("other"), "YT批量下載器擴充功能");
  assert.equal(defaultFolder("nonsense"), "YT批量下載器擴充功能");
  assert.match(folderHint("mac"), /Cmd\+Shift\+G/);
  assert.match(folderHint("win"), /網址列/);
  for (const os of ["mac", "win", "other"]) assert.match(folderHint(os), /新增資料夾/, `${os}: says how to make the folder`);
});

// ---------------- the steps ----------------

const running = { state: "running", ready: { hostVersion: "0.2.3", ytdlpVersion: "2026.08.19", ffmpegOk: true, jsRuntimeOk: true }, detail: null };
const stopped = { state: "stopped", ready: null, detail: null };

test("stepStates follows the person from step to step", () => {
  assert.deepEqual(stepStates({ detected: false, wroteFiles: false, status: stopped }), ["now", "todo", "todo", "todo"]);
  assert.deepEqual(stepStates({ detected: false, wroteFiles: true, status: stopped }), ["done", "now", "todo", "todo"]);
  assert.deepEqual(stepStates({ detected: true, wroteFiles: false, status: { state: "not_installed", ready: null, detail: "not found" } }), ["done", "done", "now", "todo"]);
  assert.deepEqual(stepStates({ detected: true, wroteFiles: false, status: stopped }), ["done", "done", "now", "todo"]);
  assert.deepEqual(stepStates({ detected: true, wroteFiles: false, status: { state: "stopped", ready: null, detail: "Native host has exited." } }), ["done", "done", "done", "now"]);
  assert.deepEqual(stepStates({ detected: true, wroteFiles: false, status: { state: "forbidden", ready: null, detail: "x" } }), ["done", "done", "done", "now"]);
  assert.deepEqual(stepStates({ detected: true, wroteFiles: false, status: running }), ["done", "done", "done", "done"]);
  assert.deepEqual(stepStates({ detected: false, wroteFiles: false, status: running }), ["now", "todo", "todo", "todo"], "no extension, no progress");
});

// ---------------- does it work? ----------------

const good = { detected: true, status: running, hostOutdated: false, extensionVersion: "0.2.3", pageVersion: "0.2.3" };

test("the install counts as working only when everything that a download needs is there", () => {
  assert.equal(isDeployed(good), true);
  assert.equal(isDeployed({ ...good, detected: false }), false);
  assert.equal(isDeployed({ ...good, status: stopped }), false);
  assert.equal(isDeployed({ ...good, hostOutdated: true }), false);
  assert.equal(isDeployed({ ...good, extensionVersion: "0.2.2" }), false, "an extension older than the page was not updated");
  assert.equal(isDeployed({ ...good, extensionVersion: "0.3.0" }), true);
  assert.equal(isDeployed({ ...good, pageVersion: null }), true, "page version unknown: no verdict on it");
  for (const missing of [{ ytdlpVersion: null }, { ffmpegOk: false }, { jsRuntimeOk: false }]) {
    assert.equal(isDeployed({ ...good, status: { ...running, ready: { ...running.ready, ...missing } } }), false, JSON.stringify(missing));
  }
});

// ---------------- the self-check screen ----------------

const items = (overrides) => selfCheckItems({ ...good, everDetected: true, gaveUp: false, doctor: null, ...overrides });
const byId = (list) => Object.fromEntries(list.map((i) => [i.id, i]));

test("a healthy install gets only green lines", () => {
  const list = items({});
  assert.ok(list.length >= 3);
  assert.ok(list.every((i) => i.status === "ok"), JSON.stringify(list.filter((i) => i.status !== "ok")));
  assert.match(byId(list).extension.title, /v0\.2\.3/);
});

test("without the extension that is the only thing said, with the way forward", () => {
  const never = items({ detected: false, everDetected: false, extensionVersion: null });
  assert.deepEqual(never.map((i) => i.id), ["extension"]);
  assert.equal(never[0].status, "error");
  assert.match(never[0].title, /還沒偵測到擴充功能/);
  assert.match(never[0].fix, /步驟 1/);
  const lost = items({ detected: false, everDetected: true, extensionVersion: null });
  assert.match(lost[0].title, /連線中斷/);
  assert.match(lost[0].fix, /chrome:\/\/extensions/);
});

test("an old extension, an old host and a host that is not there each say what to do", () => {
  const stale = byId(items({ extensionVersion: "0.2.1" }));
  assert.equal(stale.version.status, "error");
  assert.ok(stale.version.title.includes("0.2.1") && stale.version.title.includes("0.2.3"));
  assert.match(stale.version.fix, /重新載入/);

  const old = byId(items({ hostOutdated: true }));
  assert.equal(old.host.status, "error");
  assert.match(old.host.title, /版本太舊/);

  const notInstalled = byId(items({ status: { state: "not_installed", ready: null, detail: "Specified native messaging host not found." } }));
  assert.equal(notInstalled.host.status, "error");
  assert.match(notInstalled.host.fix, /安裝檔/);

  const forbidden = byId(items({ status: { state: "forbidden", ready: null, detail: "x" } }));
  assert.match(forbidden.host.title, /拒絕/);

  const crashing = byId(items({ status: { state: "stopped", ready: null, detail: "Native host has exited." }, gaveUp: true }));
  assert.equal(crashing.host.status, "error");
  assert.match(crashing.host.fix, /重新執行安裝檔/);

  const connecting = byId(items({ status: stopped }));
  assert.equal(connecting.host.status, "warn", "still trying: not an error yet");
  assert.match(connecting.host.title, /連線/);
});

test("a host that runs but lacks a part says which one", () => {
  const list = byId(items({ status: { ...running, ready: { ...running.ready, ytdlpVersion: null, ffmpegOk: false, jsRuntimeOk: false } } }));
  assert.equal(list.host.status, "ok");
  for (const id of ["engine", "ffmpeg", "deno"]) {
    assert.equal(list[id].status, "error", id);
    assert.match(list[id].fix, /重新執行安裝檔/);
  }
});

test("the host's own environment report replaces the quick one when it has been fetched", () => {
  const doctor = [{ id: "engine", status: "ok", title: "下載引擎 yt-dlp 2026.08.19", detail: "", fix: "" },
    { id: "ffmpeg", status: "error", title: "ffmpeg 無法執行", detail: "bad cpu type", fix: "softwareupdate --install-rosetta" },
    { id: "network", status: "warn", title: "連不到 YouTube", detail: "", fix: "換個網路" }];
  const list = items({ doctor, status: { ...running, ready: { ...running.ready, ffmpegOk: false } } });
  assert.deepEqual(list.map((i) => i.id).filter((id) => ["engine", "ffmpeg", "network"].includes(id)), ["engine", "ffmpeg", "network"]);
  assert.equal(list.filter((i) => i.id === "ffmpeg").length, 1, "not twice");
  assert.match(byId(list).ffmpeg.fix, /rosetta/);
  const without = items({ doctor, detected: false, everDetected: true, extensionVersion: null });
  assert.deepEqual(without.map((i) => i.id), ["extension"], "no host, no host report");
});

// ---------------- when the window opens ----------------

test("the first visit opens the setup window (after a moment, so that a working install is not flashed at)", () => {
  assert.equal(decideView({ firstVisit: true, deployed: false, detected: false, sinceLoadMs: 100 }), "hidden");
  assert.equal(decideView({ firstVisit: true, deployed: false, detected: false, sinceLoadMs: FIRST_SHOW_DELAY_MS }), "setup");
  assert.equal(decideView({ firstVisit: true, deployed: true, detected: true, sinceLoadMs: 5000 }), "hidden");
});

test("later visits stay quiet while it works and open the self-check when it does not, after a moment to connect", () => {
  assert.equal(decideView({ firstVisit: false, deployed: true, detected: true, sinceLoadMs: 20000 }), "hidden");
  assert.equal(decideView({ firstVisit: false, deployed: false, detected: false, sinceLoadMs: SETTLE_MS.extension - 1 }), "hidden");
  assert.equal(decideView({ firstVisit: false, deployed: false, detected: false, sinceLoadMs: SETTLE_MS.extension }), "check");
  assert.equal(decideView({ firstVisit: false, deployed: false, detected: true, sinceLoadMs: SETTLE_MS.extension }), "hidden", "the host still has time");
  assert.equal(decideView({ firstVisit: false, deployed: false, detected: true, sinceLoadMs: SETTLE_MS.host }), "check");
  assert.ok(SETTLE_MS.host > SETTLE_MS.extension);
});

test("a window the person closed stays closed, and success always wins", () => {
  assert.equal(decideView({ firstVisit: true, deployed: false, detected: false, sinceLoadMs: 9000, dismissed: true }), "hidden");
  assert.equal(decideView({ firstVisit: false, deployed: false, detected: true, sinceLoadMs: 99999, dismissed: true }), "hidden");
  assert.equal(decideView({ firstVisit: true, deployed: true, detected: true, sinceLoadMs: 9000, dismissed: false }), "hidden");
});
