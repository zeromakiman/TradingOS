// Process-local, one-use capabilities. Only the budget gate may mint a live permit.
const permits = new WeakSet<object>();
export function issueAiPermit() { const permit = Object.freeze({}); permits.add(permit); return permit; }
export function consumeAiPermit(permit: object | undefined) {
 if (!permit || !permits.delete(permit)) throw new Error("A reserved AI request is required.");
}
