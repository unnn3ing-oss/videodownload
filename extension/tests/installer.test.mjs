import test from "node:test";
import assert from "node:assert/strict";
import { downloadInstaller } from "../lib/installer.js";

const BYTES = new Uint8Array([0x50, 0x4b, 3, 4, 255, 0, 13, 10, 200]); // includes a CRLF and bytes above 127

function setup({ os = "mac", status = 200, states = [{ state: "complete" }], downloadThrows = null } = {}) {
  const calls = { fetched: [], downloaded: [], searched: 0 };
  const queue = [...states];
  const env = {
    runtime: {
      getPlatformInfo: async () => ({ os }),
      getURL: (path) => `chrome-extension://abc/${path}`,
    },
    fetchFn: async (url) => {
      calls.fetched.push(url);
      return { ok: status === 200, status, arrayBuffer: async () => BYTES.buffer.slice(0) };
    },
    downloads: {
      download: async (options) => {
        calls.downloaded.push(options);
        if (downloadThrows) throw new Error(downloadThrows);
        return 7;
      },
      search: async ({ id }) => {
        calls.searched += 1;
        assert.equal(id, 7);
        return [queue.length > 1 ? queue.shift() : queue[0]];
      },
    },
    pollMs: 0,
    timeoutMs: 50,
  };
  return { env, calls };
}

const decode = (url) => new Uint8Array(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));

test("the installer is read inside the extension and saved from a data: address, not a chrome-extension:// one", async () => {
  const { env, calls } = setup();
  assert.deepEqual(await downloadInstaller(env), { ok: true, os: "mac", name: "install-mac.zip" });
  assert.deepEqual(calls.fetched, ["chrome-extension://abc/installers/install-mac.zip"]);
  assert.equal(calls.downloaded.length, 1);
  const [download] = calls.downloaded;
  assert.equal(download.filename, "install-mac.zip");
  assert.match(download.url, /^data:application\/zip;base64,/, "Chrome fails (NETWORK_FAILED) when a service worker asks it to download a chrome-extension:// address");
  assert.deepEqual(decode(download.url), BYTES, "the bytes arrive unchanged");
});

test("the Windows installer keeps its line endings", async () => {
  const { env, calls } = setup({ os: "win" });
  assert.deepEqual(await downloadInstaller(env), { ok: true, os: "win", name: "install-windows.cmd" });
  assert.equal(calls.downloaded[0].filename, "install-windows.cmd");
  assert.match(calls.downloaded[0].url, /^data:application\/octet-stream;base64,/);
  assert.deepEqual(decode(calls.downloaded[0].url), BYTES);
});

test("other systems get a clear message and nothing is fetched", async () => {
  const { env, calls } = setup({ os: "linux" });
  assert.deepEqual(await downloadInstaller(env), { ok: false, error: "目前只支援 Windows 與 Mac" });
  assert.deepEqual([calls.fetched, calls.downloaded], [[], []]);
});

test("an extension folder without the installer says so, and says what to do", async () => {
  const { env, calls } = setup({ status: 404 });
  const result = await downloadInstaller(env);
  assert.equal(result.ok, false);
  assert.match(result.error, /找不到安裝檔.*重新部署/);
  assert.deepEqual(calls.downloaded, []);
});

test("success is reported only after Chrome has finished the download", async () => {
  const { env, calls } = setup({ states: [{ state: "in_progress" }, { state: "in_progress" }, { state: "complete" }] });
  assert.equal((await downloadInstaller(env)).ok, true);
  assert.equal(calls.searched, 3);
  assert.equal(calls.downloaded.length, 1);
});

test("a download that Chrome interrupts is an error with the reason", async () => {
  const failed = setup({ states: [{ state: "in_progress" }, { state: "interrupted", error: "NETWORK_FAILED" }] });
  const result = await downloadInstaller(failed.env);
  assert.equal(result.ok, false);
  assert.match(result.error, /無法下載安裝檔.*NETWORK_FAILED/);
  const cancelled = setup({ states: [{ state: "interrupted", error: "USER_CANCELED" }] });
  assert.match((await downloadInstaller(cancelled.env)).error, /已取消/);
});

test("a download still running after the wait counts as started", async () => {
  const { env } = setup({ states: [{ state: "in_progress" }] });
  assert.equal((await downloadInstaller(env)).ok, true);
});

test("a refused download call is an error", async () => {
  const { env } = setup({ downloadThrows: "Invalid filename" });
  assert.deepEqual(await downloadInstaller(env), { ok: false, error: "無法下載安裝檔：Invalid filename" });
});
