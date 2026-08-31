/**
 * Tavily wire types for `POST {baseURL}/search`. Kept provider-private: the
 * seam's normalized vocabulary (`@deepseek-ai/dsh-web`) is the only shape that
 * crosses this package's boundary.
 * @module @dsh-external/dsh-web-search-tavily/types
 */

/** Tavily API error envelope (FastAPI style): `detail`, sometimes `message`. */
export interface TavilyErrorBody {
  readonly detail?: unknown
  readonly message?: unknown
}

/** One entry of Tavily's `results[]`. */
export interface TavilySearchResult {
  readonly title?: string
  readonly url?: string
  /** Page content snippet (the portable excerpt). */
  readonly content?: string
  /** Provider relevance score, 0..1. */
  readonly score?: number
  /** ISO-8601 publication/crawl date, when Tavily knows one. */
  readonly published_date?: string
  readonly raw_content?: string | null
}

/** Parsed `POST /search` response envelope. */
export interface TavilySearchResponse {
  readonly query?: string
  /** Generated answer summary, present only when the request set `include_answer`. */
  readonly answer?: string | null
  readonly results?: TavilySearchResult[]
  readonly response_time?: number
}