import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildCopyText, extractHashtags } from "../lib/copytext.js";
import { coverName } from "../lib/covername.js";
import { COVER_VARIANTS, MAX_COVER_BYTES, findCover } from "../lib/cover.js";
import { versionAtLeast } from "../lib/version.js";
import { toBase64 } from "../lib/base64.js";
import { toBase64 as toBase64FromUpdater } from "../lib/updater.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

test("extractHashtags takes the first three distinct tags in order", () => {
  assert.deepEqual(extractHashtags("內文 #颱風 說明 #AI #颱風 #第三 #第四"), ["颱風", "AI", "第三"]);
  assert.deepEqual(extractHashtags("#Tag #tag #TAG #other"), ["Tag", "other"]);
  assert.deepEqual(extractHashtags("只有一個 #唯一"), ["唯一"]);
  assert.deepEqual(extractHashtags("沒有標籤，也沒有井字"), []);
  assert.deepEqual(extractHashtags("", 3), []);
  assert.deepEqual(extractHashtags("#a #b #c #d", 2), ["a", "b"]);
});

test("extractHashtags ignores # fragments inside urls and accepts tags after brackets or line starts", () => {
  assert.deepEqual(extractHashtags("看 https://youtu.be/x#t=30 與 https://a.b/c#section"), []);
  assert.deepEqual(extractHashtags("（#括號內）\n#行首\n【#方括號】"), ["括號內", "行首", "方括號"]);
  assert.deepEqual(extractHashtags("price#1 not a tag, but #real is"), ["real"]);
  assert.deepEqual(extractHashtags("#底線_tag #123"), ["底線_tag", "123"]);
});

test("buildCopyText formats title and hashtags", () => {
  assert.equal(buildCopyText("影片標題文字", ["一", "二", "三"]), "【影片標題文字】\n#一 #二 #三");
  assert.equal(buildCopyText("只有標題", []), "【只有標題】");
  assert.equal(buildCopyText("兩個", ["甲", "乙"]), "【兩個】\n#甲 #乙");
});

test("buildCopyText keeps the title on one line and never interprets markup", () => {
  assert.equal(buildCopyText("第一行\n  第二行\r\n第三行", ["x"]), "【第一行 第二行 第三行】\n#x");
  assert.equal(buildCopyText('<img src=x onerror="1">', []), '【<img src=x onerror="1">】');
  assert.equal(buildCopyText("  前後空白  ", []), "【前後空白】");
  assert.equal(buildCopyText("甲\u0085乙\u2028丙\u2029丁", []), "【甲 乙 丙 丁】", "NEL and the unicode line separators are line breaks too");
});

test("coverName agrees with the Python implementation on the shared fixture", () => {
  const cases = JSON.parse(fs.readFileSync(new URL("../../tests/fixtures/cover-names.json", import.meta.url), "utf8"));
  assert.ok(cases.length >= 7);
  for (const { title, id, expected } of cases) assert.equal(coverName(title, id), expected, title);
});

function coverFetch(available, calls = []) {
  return async (url) => {
    calls.push(url);
    const hit = available[url];
    if (!hit) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = hit instanceof Uint8Array ? hit : new Uint8Array(hit);
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
}
const variantUrl = (id, name) => `https://i.ytimg.com/vi/${id}/${name}.jpg`;

test("findCover falls back to the next size when the largest does not exist", async () => {
  const calls = [];
  const got = await findCover("abc", coverFetch({ [variantUrl("abc", "hq720")]: JPEG }, calls));
  assert.deepEqual(calls, [variantUrl("abc", "maxresdefault"), variantUrl("abc", "hq720")]);
  assert.equal(got.url, variantUrl("abc", "hq720"));
  assert.deepEqual([...got.bytes], [...JPEG]);
  assert.deepEqual(COVER_VARIANTS, ["maxresdefault", "hq720", "sddefault", "hqdefault"]);
});

test("findCover returns null when no size exists, or the answer is not a JPEG, or it is too large", async () => {
  assert.equal(await findCover("abc", coverFetch({})), null);
  const html = new TextEncoder().encode("<html>error page</html>");
  assert.equal(await findCover("abc", coverFetch(Object.fromEntries(COVER_VARIANTS.map((n) => [variantUrl("abc", n), html])))), null);
  const huge = new Uint8Array(MAX_COVER_BYTES + 1);
  huge.set([0xff, 0xd8, 0xff]);
  const calls = [];
  assert.equal(await findCover("abc", coverFetch({ [variantUrl("abc", "maxresdefault")]: huge }, calls)), null);
  assert.equal(calls.length, COVER_VARIANTS.length);
});

test("findCover treats a failing request as a missing size and keeps trying", async () => {
  const flaky = async (url) => {
    if (url.includes("maxres")) throw new Error("offline");
    return coverFetch({ [variantUrl("abc", "hq720")]: JPEG })(url);
  };
  assert.equal((await findCover("abc", flaky)).url, variantUrl("abc", "hq720"));
});

test("versionAtLeast compares numeric segments", () => {
  assert.equal(versionAtLeast("0.2.0", "0.2.0"), true);
  assert.equal(versionAtLeast("0.10.0", "0.2.0"), true);
  assert.equal(versionAtLeast("1.0", "0.2.0"), true);
  assert.equal(versionAtLeast("0.1.9", "0.2.0"), false);
  assert.equal(versionAtLeast(null, "0.2.0"), false);
  assert.equal(versionAtLeast("abc", "0.2.0"), false);
});

test("toBase64 lives in base64.js and is still exported by updater.js", () => {
  assert.equal(toBase64(new TextEncoder().encode("hello")), "aGVsbG8=");
  assert.equal(toBase64FromUpdater, toBase64);
  assert.equal(toBase64(new Uint8Array(100000)).length, Math.ceil(100000 / 3) * 4);
});

test("the cover size limit is the same in the extension and in the host", () => {
  const python = fs.readFileSync(new URL("../../host/covers.py", import.meta.url), "utf8");
  const match = /MAX_COVER_BYTES = (\d+) \* 1024 \* 1024/.exec(python);
  assert.ok(match, "host/covers.py defines MAX_COVER_BYTES in MiB");
  assert.equal(Number(match[1]) * 1024 * 1024, MAX_COVER_BYTES);
  assert.ok(Math.ceil(MAX_COVER_BYTES / 3) * 4 < 8 * 1024 * 1024, "its base64 fits one 8 MiB native message");
});
