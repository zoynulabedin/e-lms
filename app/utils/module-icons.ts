/**
 * Module icons for the course player sidebar.
 *
 * The artwork arrived as one vertical sprite per course; `scripts`-time
 * slicing produced the individual transparent PNGs in /public/module-icons.
 * They are listed in module order, so module N of a course uses icon N of its
 * set. The first entry of each set is the graduation cap used for the
 * intro / "Getting Started" module.
 */

export const ICON_SETS = {
  market: { label: "Making Markets Make Sense", count: 10 },
  money: { label: "Making Money Make Sense", count: 9 },
} as const;

export type IconSet = keyof typeof ICON_SETS;

export const GETTING_STARTED_ICON = "/module-icons/getting-started-1.png";

export function isIconSet(v: unknown): v is IconSet {
  return v === "market" || v === "money";
}

/**
 * Icon for the module at `index` (0-based) of a course.
 * Returns null when the course has no icon set, so the caller can fall back
 * to its own default icon.
 */
export function moduleIcon(iconSet: string | null | undefined, index: number): string | null {
  if (!isIconSet(iconSet)) return null;
  const { count } = ICON_SETS[iconSet];
  // Courses can grow more modules than the artwork covers - reuse the last
  // icon rather than showing a broken image.
  const n = Math.min(index + 1, count);
  return `/module-icons/${iconSet}-${n}.png`;
}

/** Every icon in a set, for admin pickers/previews. */
export function iconSetImages(iconSet: IconSet): string[] {
  return Array.from(
    { length: ICON_SETS[iconSet].count },
    (_, i) => `/module-icons/${iconSet}-${i + 1}.png`,
  );
}
