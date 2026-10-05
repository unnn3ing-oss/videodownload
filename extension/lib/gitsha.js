// git's blob SHA-1: sha1("blob <byte count>\0" + content), the same value GitHub lists for each file.
export async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header, 0);
  all.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", all);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const TEXT_EXT = /\.(js|html|css|json|md|svg|txt|py)$/i;

// Files checked out on Windows may have CRLF line endings: that alone is not a new version.
export async function sameContent(path, localBytes, remoteSha) {
  if (!localBytes) return false;
  if ((await gitBlobSha(localBytes)) === remoteSha) return true;
  if (!TEXT_EXT.test(path)) return false;
  const text = new TextDecoder().decode(localBytes).replace(/\r\n/g, "\n");
  return (await gitBlobSha(new TextEncoder().encode(text))) === remoteSha;
}
