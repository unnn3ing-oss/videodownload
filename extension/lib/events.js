export function emptyProgress() {
  return { items: {}, summary: null };
}

export function applyEvent(state, event) {
  const patch = (id, fields) => ({
    ...state,
    items: { ...state.items, [id]: { ...state.items[id], ...fields } },
  });
  switch (event.type) {
    case "progress":
      return patch(event.itemId, {
        status: "downloading",
        percent: event.percent ?? state.items[event.itemId]?.percent ?? null,
        speed: event.speed ?? null,
        eta: event.eta ?? null,
      });
    case "item_done":
      return event.skipped
        ? patch(event.itemId, { status: "skipped", file: event.file })
        : patch(event.itemId, {
            status: "done",
            percent: 100,
            file: event.file,
            height: event.height ?? null,
            codec: event.codec ?? null,
            warnNotH264: Boolean(event.codec) && !event.codec.startsWith("avc1"),
          });
    case "item_failed":
      return patch(event.itemId, { status: "failed", reason: event.reason, code: event.code });
    case "done":
      return { ...state, summary: event.summary };
    default:
      return state;
  }
}
