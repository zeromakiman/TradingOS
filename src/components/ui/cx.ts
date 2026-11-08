import { type ClassValue, clsx } from "clsx";

/**
 * Joins class names without tailwind-merge. Primitives are styled by component classes
 * (`@layer components`), so a caller's utility already wins through the cascade, and
 * tailwind-merge would misread the design-token utilities (it treats `text-2` and a
 * font-size utility as the same group and drops one of them).
 */
export function cx(...inputs: ClassValue[]) {
  return clsx(inputs);
}
