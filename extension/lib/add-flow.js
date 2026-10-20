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

// The address box follows the current tab: a YouTube address is put in it, any other tab leaves it empty to paste into.
// `filled` is what was last put there by this function. The box is only touched while it is empty or still holds that:
// whatever else is in it was typed or pasted by the person (or is a rejected address they are fixing) and stays.
// A box emptied after its video was added is not filled again by the same tab; going to another site forgets it.
export function tabAutofill({ box, filled, tabUrl }) {
  const target = tabUrl ?? "";
  if (box !== "" && box !== filled) return { box, filled: "" }; // theirs: kept, and what was filled earlier no longer counts
  if (box === "" && target !== "" && target === filled) return { box, filled };
  return { box: target, filled: target };
}
