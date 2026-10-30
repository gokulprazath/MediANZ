import "server-only";
// The mock database lives in the Next.js server's memory, so every tab and
// portal sees the same data (a patient and a clinician can consent from two
// windows). It resets when the dev server restarts or POST /api/mock/reset.
import { buildSeed, type MockState } from "./seed";

const KEY = Symbol.for("medianz.mock.state");
type Holder = { [KEY]?: MockState };

export function getMockState(): MockState {
  const g = globalThis as Holder;
  g[KEY] ??= buildSeed();
  return g[KEY];
}

export function resetMockState(): MockState {
  const g = globalThis as Holder;
  g[KEY] = buildSeed();
  return g[KEY];
}
