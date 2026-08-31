# dsh-web-search-tavily

[中文说明](#中文说明)

Tavily-backed web search provider for the DeepSeek Harness web capability seam
(`ctx.web`). It replaces the DeepSeek native-search route — which spends a full
Messages **model turn** (tokens + latency) on every `web_search` — with a pure
REST retrieval call to Tavily: **zero model tokens per search**, same
model-facing `web_search` schema, no harness source changes.

## What it does

- Registers a `WebSearchProvider` (id `tavily`) into `ctx.web`.
- One search = `POST https://api.tavily.com/search` (`Authorization: Bearer`).
- Maps `results[]` → seam sources (`title`, `url`, `content`→`snippet`,
  `published_date`→`publishedAt`); optional generated `answer` → result
  `content` (off by default: saves credits/latency; enable in settings).
- The API key resolves per search through: the **web-search-tavily settings
  section** (GUI), the credentials service, or the launching environment
  (`$TAVILY_API_KEY`).

## Install

```bash
# build & pack
bash scripts/build.sh && npm pack
# install into the web profile (junction + bundles entry + live mount)
dsh install-package D:/collection_of_projects/dsh/dsh-web-search-tavily web
```

Then switch the seam to the Tavily provider — profile patch layer
(`profiles/<name>/cordis.patch.yml`):

```yaml
- id: web
  config:
    searchProvider: tavily
```

(Or set `$DSH_WEB_SEARCH_PROVIDER=tavily` in the launching environment.)

**Restart the harness** — the `web` row's provider pin is read at boot.

## First use

1. Get an API key at https://app.tavily.com (free tier: 1,000 credits/month).
2. Open DSH settings → **Plugins → Configurable** → the **Tavily search
   (`web-search-tavily`)** card (or export `TAVILY_API_KEY`) and store the key —
   the key goes to the credentials domain, never the settings document.
3. Ask for a web search. Missing key → a clear error pointing to the settings
   section; no silent fallback to DeepSeek.

Verify: search responses stop costing model turns — sessions no longer record
`web/deepseek-search-llm-request` events and searches resolve in seconds.

## Config (settings section `web-search-tavily`)

| Key | Default | Meaning |
| --- | --- | --- |
| `apiKey` | — | Literal Tavily key (secret field) |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential reference |
| `baseURL` | `https://api.tavily.com` | Endpoint base (`$TAVILY_BASE_URL` env override) |
| `searchDepth` | `basic` | `basic` or `advanced` |
| `maxResults` | `8` | Results per search (capped at Tavily's 20) |
| `includeAnswer` | `false` | Request Tavily's generated answer (extra credit/latency) |
| `days` | — | Recency filter: last N days (1..30) |

## Uninstall

Remove the `web` override from the profile patch (restore `deepseek-official`
or delete the entry), remove the plugin from the profile's `bundles`, unlink
the junction — then restart. If the `web.searchProvider: tavily` pin outlives
the provider, search fails with a "configured but unavailable" error.

---

## 中文说明

Tavily 版 web 搜索 provider，接入 DSH web 能力 seam（`ctx.web`）。取代
DeepSeek 原生搜索路线（每次 `web_search` 消耗一次完整 Messages 模型轮次的
token 与延迟）：每次搜索变为纯 REST 检索，**零模型 token**，模型可见的
`web_search` schema 不变，不改 harness 源码。

要点：注册 id `tavily` 的 `WebSearchProvider`；密钥按次解析（设置面板
`web-search-tavily` 一节 / credentials 服务 / `$TAVILY_API_KEY` 环境变量）；
设置 `searchProvider: tavily` 在 profile patch 层完成，**需重启生效**；
未填 key 时报可读错误并指引设置页，不会静默回退 DeepSeek。