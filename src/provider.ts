/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by the Tavily search API
 * (`POST /search`). Pure REST retrieval — one search costs zero model tokens
 * (unlike the DeepSeek native-search route, which spends a full Messages model
 * turn). Maps Tavily's `results[]` (`title`/`url`/`content`/`published_date`)
 * to the seam's normalized `WebSearchSource`, and takes the optional generated
 * `answer` as `content` only when the deployment opts into `includeAnswer`.
 * @module @dsh-external/dsh-web-search-tavily/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { TavilyErrorBody, TavilySearchResponse, TavilySearchResult } from './types.ts'

/** Stable id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily endpoint; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Hard upper bound Tavily accepts for one search's `max_results`. */
export const TAVILY_MAX_RESULTS_CAP = 20

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'dsh-web-search-tavily/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface TavilySearchProviderOptions {
  /** Literal Tavily API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Tavily API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL: string
  /** Retrieval depth sent as Tavily's `search_depth`. Defaults to `basic`. */
  searchDepth: 'basic' | 'advanced'
  /** Default result count when a request carries no `maxResults`. */
  maxResults: number
  /** Ask Tavily for a generated answer (extra latency/credit); seam `content` when present. */
  includeAnswer: boolean
  /** Restrict results to the last N days (Tavily's `days`), when set (1..30). */
  days?: number
}

/**
 * Map one Tavily result to a normalized source, or `undefined` when it carries
 * no URL (the seam's citation shape is keyed by URL; inventing one would lie).
 *
 * @param result - one entry of Tavily's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export function mapTavilyResult(result: TavilySearchResult): WebSearchSource | undefined {
  if (result.url == null || result.url.length === 0) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.content != null && result.content.trim().length > 0 ? { snippet: result.content.trim() } : {},
    ...result.published_date != null && result.published_date.length > 0 ? { publishedAt: result.published_date } : {},
  }
}

/**
 * Map a Tavily response envelope to a normalized search result. When
 * `includeAnswer` is on and Tavily generated an `answer`, it becomes the
 * result's optional `content` (the seam's answer slot, as Perplexity fills it).
 * The web service owns the final `maxResults` truncation, so `truncated` is
 * always `false` here.
 *
 * @param response - the parsed `POST /search` response body.
 * @param includeAnswer - whether the request asked for a generated answer.
 * @returns the normalized result; URL-less entries are dropped.
 */
export function mapTavilyResponse(
  response: TavilySearchResponse,
  includeAnswer: boolean,
): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapTavilyResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  const answer = includeAnswer && response.answer != null && response.answer.length > 0
    ? response.answer
    : undefined
  return {
    ...answer !== undefined ? { content: answer } : {},
    sources,
    truncated: false,
  }
}

/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two settings
   * writes. A thunk rather than a value because the plugin's settings section
   * can change between searches.
   */
  constructor(private readonly resolveOptions: () => TavilySearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxResults)
      && (options.searchDepth === 'basic' || options.searchDepth === 'advanced')
      && (options.days === undefined || isValidDays(options.days))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // settings write landing inside that await must not send the key resolved
    // from the old section to the endpoint named by the new one.
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfSearchAborted(signal)
    const endpoint = `${options.baseURL}/search`
    const numResults = request.maxResults ?? options.maxResults
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          // Current Tavily auth: Bearer header (the legacy `api_key` body
          // field is deprecated). Matches the Exa/Perplexity provider style.
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          query: request.query,
          search_depth: options.searchDepth,
          max_results: clampResults(numResults),
          include_answer: options.includeAnswer,
          ...options.days !== undefined ? { days: options.days } : {},
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Tavily API error (HTTP ${status})`
      try {
        const parsed = await response.json() as TavilyErrorBody
        const detail = typeof parsed.detail === 'string' ? parsed.detail
          : typeof parsed.message === 'string' ? parsed.message
          : undefined
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as TavilySearchResponse
      return mapTavilyResponse(payload, options.includeAnswer)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved key.
   */
  private async apiKey(options: TavilySearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfSearchAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(
        `Tavily search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'TAVILY_API_KEY'
    throw new WebError(
      `Tavily search has no API key for "${ref}"; store it in the web-search-tavily`
      + ' settings section, export it in the launching environment, or set a literal'
      + ' "apiKey" in the web-search-tavily config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** Clamp a result count to Tavily's accepted range (1..20). */
function clampResults(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), TAVILY_MAX_RESULTS_CAP)
}

/** True when a result count request is a positive whole number. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for Tavily's recency filter window (1..30 days). */
function isValidDays(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 30
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Tavily search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}