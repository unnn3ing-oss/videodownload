// What 「加入」 leaves behind. `outcomes`: one { url, ok, error } per pasted url, in order.
// Rejected urls stay in the box (one per line) so they can be fixed and sent again; the note says how many and why.
export function summarizeAdd(outcomes) {
  const rejected = outcomes.filter((o) => !o.ok);
  if (!rejected.length) return { remaining: "", note: "" };
  const reasons = new Map();
  for (const { error } of rejected) reasons.set(error ?? "無法加入", (reasons.get(error ?? "無法加入") ?? 0) + 1);
  const why = [...reasons].map(([text, count]) => `${text}：${count} 個`).join("；");
  const added = outcomes.length - rejected.length;
  const lead = added ? `已加入 ${added} 個網址；${rejected.length} 個沒有加入` : `${rejected.length} 個網址沒有加入`;
  return { remaining: rejected.map((o) => o.url).join("\n"), note: `${lead}，已留在輸入框（${why}）。` };
}
