/** Original octopus silhouette as an SVG path (bounding box roughly x:[6,94] y:[4,120]).
 *  A rounded mantle (head) with a five-lobe tentacle fringe below. Drawn as a canvas Path2D,
 *  fill evenodd. Mantle center ≈ (50, 35) — translate by its negative before scaling so
 *  rotation pivots on the body, tentacles trailing behind. */
export const OCTOPUS_PATH_D =
  'M15,42 C15,20 30,4 50,4 C70,4 85,20 85,42 C85,52 78,54 74,60 C84,68 94,80 90,98 ' +
  'C86,82 76,70 68,64 C72,74 76,92 66,112 C62,94 58,80 56,66 C58,78 58,98 50,120 ' +
  'C42,98 42,78 44,66 C42,80 38,94 34,112 C24,92 28,74 32,64 C24,70 14,82 10,98 ' +
  'C6,80 16,68 26,60 C22,54 15,52 15,42 Z';

export const OCTOPUS_PATH_CENTER = { x: 50, y: 35 } as const;
