// Whole-queue progress: finished items count fully, downloading items count by their own percent.
export function overallProgress(items) {
  const rows = Object.values(items ?? {});
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let partial = 0;
  for (const row of rows) {
    if (row.status === "done") done += 1;
    else if (row.status === "skipped") skipped += 1;
    else if (row.status === "failed") failed += 1;
    else if (row.status === "downloading" && Number.isFinite(row.percent)) {
      partial += Math.min(100, Math.max(0, row.percent)) / 100;
    }
  }
  const total = rows.length;
  const finished = done + skipped + failed;
  const percent = total ? Math.min(100, Math.round(((finished + partial) / total) * 1000) / 10) : 0;
  return { total, finished, done, skipped, failed, percent };
}

// Rows shown right after a resolve, before any download starts.
export function previewItems(items) {
  const rows = {};
  for (const item of items ?? []) {
    rows[item.id || item.url] = item.id
      ? { title: item.title || item.id, status: "preview" }
      : { title: item.url, status: "preview", unresolved: true };
  }
  return rows;
}

// Queued rows for a download that is about to start, so progress events keep showing titles.
export function seedProgress(items) {
  const rows = {};
  for (const item of items ?? []) {
    if (item.id) rows[item.id] = { title: item.title || item.id, status: "queued" };
  }
  return { items: rows, summary: null };
}
