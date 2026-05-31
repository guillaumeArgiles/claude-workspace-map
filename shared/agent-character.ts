/**
 * Deterministic character names for agents.
 *
 * Each NPC on the map gets a stable, human-readable first name derived from
 * its identifier (sessionId for teachers, tool_use_id for sub-agents). Same
 * id → same name across reloads, restarts, and different machines.
 *
 * Mix of fantasy / nature / short modern names that fit the pixel-art RPG
 * vibe. ~50 entries = plenty of variety for a typical fleet of 5-30 agents,
 * with occasional collisions on very large fleets (acceptable — agents that
 * share a name still differ by project, so identity remains unambiguous).
 *
 * Source of truth shared between server (could pre-compute) and client
 * (currently the only consumer via AgentSyncer).
 */

const NAME_POOL: readonly string[] = [
  "Aria", "Bran", "Cyrus", "Dara", "Elin", "Finn", "Gaia", "Hugo",
  "Iris", "Jin", "Kira", "Liam", "Mira", "Nox", "Orin", "Petra",
  "Quill", "Runa", "Sage", "Tov", "Una", "Vera", "Wren", "Xara",
  "Yara", "Zoe", "Atlas", "Bell", "Cyan", "Dune", "Echo", "Fern",
  "Glade", "Heron", "Indie", "Jove", "Karst", "Lark", "Moss", "Nimbus",
  "Onyx", "Pine", "Reef", "Tide", "Umber", "Vesper", "Willow", "Yarrow",
  "Zephyr", "Astrid",
];

/**
 * FNV-1a 32-bit string hash. Deterministic, fast, no external dep.
 * Returns an unsigned integer.
 */
function hashFnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiplication by FNV prime 16777619, kept in 32-bit unsigned range.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Pick a stable character name for an entity by hashing its identifier
 * into the {@link NAME_POOL}.
 *
 * @param id sessionId for teacher agents, tool_use_id for sub-agents.
 *           Pass any stable string — the function is purely deterministic.
 */
export function characterNameFor(id: string): string {
  const idx = hashFnv1a(id) % NAME_POOL.length;
  return NAME_POOL[idx]!;
}

/** Exposed for tests / debug. */
export const __NAME_POOL_SIZE = NAME_POOL.length;
