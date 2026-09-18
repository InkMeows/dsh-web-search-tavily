/**
 * Register a Tavily-backed provider in `ctx.web`. It calls Tavily's dedicated
 * search REST endpoint, so one search costs zero model tokens — replacing the
 * DeepSeek native-search route (a full Messages model turn per search) while
 * keeping the model-facing `web_search` schema untouched. The API key resolves
 * through the credentials seam and the launching environment, and the plugin
 * owns a `web-search-tavily` settings section where the key can be stored
 * directly from the GUI.
 * @module @dsh-external/dsh-web-search-tavily
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { TavilySearchProvider, TAVILY_DEFAULT_BASE_URL, TAVILY_PROVIDER_ID } from './provider.ts'
import type { TavilySearchProviderOptions } from './provider.ts'

export {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_PROVIDER_ID,
  TavilySearchProvider,
  mapTavilyResponse,
  mapTavilyResult,
} from './provider.ts'
export type { TavilySearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'

/**
 * Environment variable naming this provider's endpoint override. Distinct from
 * the harness's own search-base vocabulary: Tavily is a plain REST API.
 */
const BASE_URL_ENV = 'TAVILY_BASE_URL'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Tavily API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each search; defaults to `TAVILY_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Retrieval depth sent as Tavily's `search_depth`. Defaults to `basic`. */
  searchDepth?: 'basic' | 'advanced'
  /** Default result count when a request carries no explicit bound. Defaults to 8. */
  maxResults?: number
  /** Ask Tavily for a generated answer (extra latency/credit). Defaults to false. */
  includeAnswer?: boolean
  /** Restrict results to the last N days (1..30), when set. */
  days?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  searchDepth: z.union(['basic', 'advanced'] as const).default('basic'),
  maxResults: z.number().step(1).min(1).default(8),
  includeAnswer: z.boolean().default(false),
  days: z.number().step(1).min(1).max(30),
})

/** Settings namespace carrying this provider's key reference and search options. */
export const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = 'web-search-tavily'

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): TavilySearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(BASE_URL_ENV)?.value
      ?? TAVILY_DEFAULT_BASE_URL,
    searchDepth: config.searchDepth ?? 'basic',
    maxResults: config.maxResults ?? 8,
    includeAnswer: config.includeAnswer ?? false,
    ...config.days !== undefined ? { days: config.days } : {},
  }
}

/** Register the Tavily search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      // The registration carries no resolved value: the provider projects the
      // section per search, so a committed change needs no re-registration.
      onChange: () => {},
    })
  })
  ctx.web.registerSearchProvider(new TavilySearchProvider(() => resolveOptions(ctx, current())))
}