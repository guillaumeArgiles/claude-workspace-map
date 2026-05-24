/**
 * Tunable values for player / NPC behaviour and rendering. Kept in one place
 * so we can iterate on feel without hunting through code.
 */

// --- Player ---
/** Width/height of the programmatic placeholder sprite (px, native). */
export const PLAYER_W = 18;
export const PLAYER_H = 24;
/** Movement speed in pixels per second. */
export const PLAYER_SPEED = 220;

// --- Interaction ---
/** Radius (px) around the player within which we surface the talk-to prompt. */
export const INTERACTION_RADIUS = 90;

// --- NPC wandering ---
export const NPC_SPEED = 55;
export const NPC_WANDER_RADIUS = 80;
export const NPC_PAUSE_MIN = 1500;
export const NPC_PAUSE_MAX = 4000;
export const NPC_REACH_DIST = 6;
export const NPC_STUCK_TIMEOUT = 400;

// --- Sprite rendering ---
/** Final on-screen height (px) for any character with a real sprite.
 *  48 px = 2/3 of one 72-px cell — characters feel human-scaled and leave
 *  clear walking room in single-cell corridors.
 */
export const TARGET_CHAR_HEIGHT = 48;
/**
 * Native texture height (px) after downsample. Smaller than the displayed
 * size on purpose: Phaser scales it back up with nearest-neighbour, giving
 * visible chunky pixels that match the map's pixel art density.
 */
export const TARGET_NATIVE_HEIGHT = 24;

// --- Hitbox / collisions ---
/** Hitbox fraction of the sprite: centred horizontally, anchored at feet. */
export const HITBOX_W_RATIO = 0.7;
export const HITBOX_H_RATIO = 0.5;

// --- Camera ---
/** 1.0 shows the whole map, >1 zooms in on the player. */
export const CAMERA_ZOOM = 1.2;
