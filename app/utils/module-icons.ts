/**
 * Module icons for the course player sidebar.
 *
 * The artwork arrived as one vertical sprite per course; `scripts`-time
 * slicing produced the individual transparent PNGs in /public/module-icons.
 * The sprite is numbered BY MODULE, as supplied: icon 1 belongs to "Module 1",
 * icon 2 to "Module 2", and so on. A course that opens with an intro section
 * ("Getting Started") must therefore NOT consume icon 1 for it - the intro has
 * its own compass icon, and the numbered modules still line up with the sprite.
 * Use isIntroModuleTitle() to spot that section.
 */

export const ICON_SETS = {
  market: { label: "Making Markets Make Sense", count: 10 },
  money: { label: "Making Money Make Sense", count: 9 },
} as const;

export type IconSet = keyof typeof ICON_SETS;

export const GETTING_STARTED_ICON = "/module-icons/getting-started-1.png";

/**
 * Does this module title name the intro section rather than a numbered module?
 *
 * Matched on the title because position alone cannot tell them apart: some
 * courses open with "Getting Started", others go straight to "Module 1", and
 * getting this wrong shifts every icon in the course by one.
 */
const INTRO_TITLE =
  /^\s*(getting started|get started|start here|introduction|intro|welcome|course overview|overview)\b/i;

export function isIntroModuleTitle(title: string | null | undefined): boolean {
  return INTRO_TITLE.test(String(title ?? ""));
}

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
