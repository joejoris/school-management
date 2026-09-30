/**
 * Pagination, and why it is on every list operation.
 *
 * This exists to stop one specific failure: a mock fits in memory so it returns
 * all 2,000 rows, then the real backend paginates, and every screen breaks at
 * once. If a list operation cannot express a page, it is not ready for the
 * contract.
 *
 * `hasMore` is present rather than left for the UI to infer from `items.length`,
 * because "is there another page" is a question about the database and the
 * answer should come from it rather than be guessed at from a row count.
 */
import { z } from 'zod'

export const PageQuery = z.object({
  limit: z.number().int().min(1).max(200).default(25),
  offset: z.number().int().min(0).default(0),
  /** Stable sort key. Omitted means the implementation's own default. */
  sort: z.string().optional(),
  /**
   * Tiebreaker for stable pagination.
   *
   * Sorting by a column with duplicates gives two pages that can repeat or skip
   * rows at the boundary. A cursor on the tiebreaker is what stops a librarian
   * paging the register and seeing the same loan on two pages.
   */
  cursor: z.string().optional(),
})
export type PageQuery = z.infer<typeof PageQuery>

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
  /** True when rows exist past this page. Lets the UI show "Load more". */
  hasMore: boolean
}

export function page<T>(
  items: T[],
  total: number,
  query: Pick<PageQuery, 'limit' | 'offset'>,
): Page<T> {
  return {
    items,
    total,
    limit: query.limit,
    offset: query.offset,
    hasMore: query.offset + items.length < total,
  }
}

/** Slices an in-memory array into a Page. What the mock uses. */
export function paginate<T>(rows: T[], query: PageQuery): Page<T> {
  return page(rows.slice(query.offset, query.offset + query.limit), rows.length, query)
}

/**
 * Validates a page of T at a boundary.
 *
 * Without this, list endpoints would be the one place a response reaches the UI
 * unchecked, and a wrong `total` or `hasMore` shows up as a subtly broken list
 * rather than a crash — which is the harder kind of bug to trace back to a
 * response shape.
 */
export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
    hasMore: z.boolean(),
  })
}