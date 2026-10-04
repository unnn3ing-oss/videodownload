// Request ids must be unique across popup instances: a reply meant for a closed popup
// must never be mistaken for the answer to a request made by the next one.
export function createRequestIds() {
  const prefix = crypto.randomUUID();
  let n = 0;
  return () => `${prefix}:${++n}`;
}
