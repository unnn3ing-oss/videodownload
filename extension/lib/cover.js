// Original-size cover image of a YouTube video: the largest size that exists.
export const COVER_VARIANTS = ["maxresdefault", "hq720", "sddefault", "hqdefault"];
export const MAX_COVER_BYTES = 8 * 1024 * 1024;

const isJpeg = (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

// Not every video has every size, so a missing, oversized or non-JPEG answer just means "try the next one".
export async function findCover(id, fetchFn = fetch) {
  for (const name of COVER_VARIANTS) {
    const url = `https://i.ytimg.com/vi/${id}/${name}.jpg`;
    try {
      const response = await fetchFn(url, { credentials: "omit" });
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length <= MAX_COVER_BYTES && isJpeg(bytes)) return { url, bytes };
    } catch { /* offline for this request: try the next size */ }
  }
  return null;
}
