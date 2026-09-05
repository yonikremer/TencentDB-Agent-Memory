/**
 * Color utility — extracted from App.tsx
 *
 * Team avatar color scheme: Stably select color based on team_id, ensuring the same team always displays the same color.
 */

/** Team Avatar Color List */
export const TEAM_AVATAR_COLORS = [
  'bg-rose-500', 'bg-amber-500', 'bg-blue-500', 'bg-emerald-500', 'bg-violet-500',
  'bg-cyan-600', 'bg-orange-500', 'bg-pink-500', 'bg-teal-500', 'bg-indigo-500',
];

/**
 * Stably retrieve a Tailwind background color class name based on seed (usually team_id).
 * Always return the same color for the same seed.
 */
export function teamColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TEAM_AVATAR_COLORS[h % TEAM_AVATAR_COLORS.length];
}
