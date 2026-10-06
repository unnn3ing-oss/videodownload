import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  FIRST_SHOW_DELAY_MS, FOLDER_HINTS, FOLDER_NAME, SETTLE_MS, STEP_LABELS, connectSummary, decideView, detectOs, isDeployed, macInstallCommand,
  macInstallUrl, selfCheckItems, wizardSteps,
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

test("the suggested folder is a plain name, not a path (the folder does not exist yet), and the hints say how to make it", () => {
  assert.equal(FOLDER_NAME, "YT批量下載器");
  assert.ok(!/[\\/~%:]/.test(FOLDER_NAME), "nothing that could be taken for a path");
  assert.match(FOLDER_HINTS[0], /新增資料夾/);
  assert.match(FOLDER_HINTS[0], /貼上這個名稱/);
  assert.match(FOLDER_HINTS[1], /同名的資料夾/);
  assert.match(FOLDER_HINTS[1], /下載.*文件.*桌面/);
});

// ---------------- the steps ----------------

const running = { state: "running", ready: { hostVersion: "0.2.3", ytdlpVersion: "2026.08.19", ffmpegOk: true, jsRuntimeOk: true }, detail: null };
const stopped = { state: "stopped", ready: null, detail: null };

test("the four steps, in the order the person does them", () => {
  assert.deepEqual(STEP_LABELS, ["下載安裝檔", "執行安裝檔", "載入插件", "完成"]);
});

test("wizardSteps follows the person through the steps and says which one to show", () => {
  const at = (overrides) => wizardSteps({ detected: false, passedInstaller: false, status: stopped, deployed: false, ...overrides });
  assert.deepEqual(at({}), { states: ["now", "todo", "todo", "todo"], suggested: 1 });
  assert.deepEqual(at({ passedInstaller: true }), { states: ["done", "done", "now", "todo"], suggested: 3 }, "the person moved past the installer steps");
  assert.deepEqual(at({ detected: true }), { states: ["now", "todo", "done", "todo"], suggested: 1 }, "an extension loaded by hand, no host: the installer is what is missing");
  assert.deepEqual(at({ detected: true, status: { state: "not_installed", ready: null, detail: "not found" } }).suggested, 1);
  assert.deepEqual(at({ detected: true, status: { state: "stopped", ready: null, detail: "Native host has exited." } }),
    { states: ["done", "done", "done", "now"], suggested: 4 }, "the host is installed, it just is not running");
  assert.equal(at({ detected: true, status: { state: "forbidden", ready: null, detail: "x" } }).suggested, 4);
  assert.deepEqual(at({ detected: true, status: running }).states, ["done", "done", "done", "now"], "it runs, but is not known to work yet");
  assert.deepEqual(at({ detected: true, status: running, deployed: true }), { states: Array(4).fill("done"), suggested: 4 });
  assert.deepEqual(at({ detected: false, status: running }).suggested, 1, "no extension, no progress");
});

test("the last step says in a line where the connection stands", () => {
  const say = (overrides) => connectSummary({ detected: true, deployed: false, status: running, ...overrides });
  assert.deepEqual(say({ deployed: true }), { ok: true, text: "一切正常，已經連線" });
  assert.deepEqual(say({ detected: false }), { ok: false, text: "還沒偵測到擴充功能（步驟 1～3）" });
  assert.deepEqual(say({}), { ok: false, text: "小程式已連線，但還有地方需要處理：按右上角的「自我檢查」" });
  assert.deepEqual(say({ status: { state: "not_installed", ready: null, detail: "x" } }), { ok: false, text: "還沒連上本機小程式（步驟 2）" });
  assert.deepEqual(say({ status: stopped }), { ok: false, text: "還沒連上本機小程式（步驟 2）" });
});

// ---------------- does it work? ----------------

const good ={ detected: true, status: running, hostOutdated: false, extensionVersion: "0.2.3", pageVersion: "0.2.3" };

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
  assert.match(never[0].fix, /步驟 1～3/);
  const lost = items({ detected: false, everDetected: true, extensionVersion: null });
  assert.match(lost[0].title, /連線中斷/);
  assert.match(lost[0].fix, /chrome:\/\/extensions/);
});

test("an old extension, an old host and a host that is not there each say what to do", () => {
  const stale = byId(items({ extensionVersion: "0.2.1" }));
  assert.equal(stale.version.status, "error");
  assert.ok(stale.version.title.includes("0.2.1") && stale.version.title.includes("0.2.3"));
  assert.match(stale.version.fix, /更新到最新版/);
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
  assert.equal(decideView({ firstVisit: true, deployed: false, detected: false, unhealthyMs: 100 }), "hidden");
  assert.equal(decideView({ firstVisit: true, deployed: false, detected: false, unhealthyMs: FIRST_SHOW_DELAY_MS }), "setup");
  assert.equal(decideView({ firstVisit: true, deployed: true, detected: true, unhealthyMs: 5000 }), "hidden");
});

test("later visits stay quiet while it works and open the self-check when it does not, after a moment to connect", () => {
  assert.equal(decideView({ firstVisit: false, deployed: true, detected: true, unhealthyMs: 20000 }), "hidden");
  assert.equal(decideView({ firstVisit: false, deployed: false, detected: false, unhealthyMs: SETTLE_MS.extension - 1 }), "hidden");
  assert.equal(decideView({ firstVisit: false, deployed: false, detected: false, unhealthyMs: SETTLE_MS.extension }), "check");
  assert.equal(decideView({ firstVisit: false, deployed: false, detected: true, unhealthyMs: SETTLE_MS.extension }), "hidden", "the host still has time");
  assert.equal(decideView({ firstVisit: false, deployed: false, detected: true, unhealthyMs: SETTLE_MS.host }), "check");
  assert.ok(SETTLE_MS.host > SETTLE_MS.extension);
});

test("a window the person closed stays closed, and success always wins", () => {
  assert.equal(decideView({ firstVisit: true, deployed: false, detected: false, unhealthyMs: 9000, dismissed: true }), "hidden");
  assert.equal(decideView({ firstVisit: false, deployed: false, detected: true, unhealthyMs: 99999, dismissed: true }), "hidden");
  assert.equal(decideView({ firstVisit: true, deployed: true, detected: true, unhealthyMs: 9000, dismissed: false }), "hidden");
});

test("the self-check names a local program whose version differs from the extension's", () => {
  const list = byId(items({ extensionVersion: "0.2.3", status: { ...running, ready: { ...running.ready, hostVersion: "0.2.0" } } }));
  assert.equal(list.hostVersion.status, "error");
  assert.match(list.hostVersion.title, /0\.2\.0.*0\.2\.3/);
  assert.match(list.hostVersion.fix, /更新到最新版/);
  assert.equal(byId(items({})).hostVersion, undefined, "same versions: no line");
});
