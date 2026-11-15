// Per-connection bounded windows accommodate ICE negotiation bursts.
export function createSignalBudget(clock = () => Date.now()) {
  let shortStart = clock(), longStart = shortStart, shortCount = 0, longCount = 0;
  return () => {
    const now = clock();
    if (now - shortStart >= 1000) { shortStart = now; shortCount = 0; }
    if (now - longStart >= 10000) { longStart = now; longCount = 0; }
    if (shortCount >= 120 || longCount >= 600) return false;
    shortCount++; longCount++; return true;
  };
}
