/**
 * Utility to merge CSS class names conditionally.
 * Minimal implementation — no external dependency needed.
 */
export function cn(...inputs: (string | undefined | null | false)[]): string {
  return inputs.filter(Boolean).join(" ");
}
