/**
 * The URL slug for a content entry.
 *
 * Content migrated from the old site carries an explicit `slug` (its filename
 * was unrelated), while anything authored in Sveltia gets named after its
 * title — so fall back to the file-derived id when the field is absent.
 */
export function slug(entry: { id: string; data: { slug?: string } }): string {
  return entry.data.slug ?? entry.id;
}
