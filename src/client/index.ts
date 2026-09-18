/**
 * @dsh-external/dsh-web-search-tavily — browser side.
 *
 * Registers the `web-search-tavily` card into the Plugins settings tab
 * (`settings.plugin.item`, keyed by the Host settings namespace). The Host
 * registers the namespace and the tab dispatches only namespaces that serve a
 * card, so without this half the settings section was invisible in the GUI.
 *
 * The API key deliberately does NOT ride a settings section: it is written
 * through the credentials domain addressed by `TAVILY_API_KEY` (or the
 * section-named reference), exactly like the built-in web-search card treats
 * `DEEPSEEK_API_KEY` — a secret never materializes into the settings document
 * or any response. Every other field edits the section through the bound
 * settings scope (field-level `set`/`unset` with revision fencing).
 *
 * Pure React.createElement (no JSX), no CSS modules, no locale service: styled
 * with the theme's `--dsw-*` variables and the web-app conventions.
 */

import React, { useState } from 'react'

const PLUGIN_ID = '@dsh-external/dsh-web-search-tavily'

/** The Host settings namespace this card edits (spelled, never imported). */
const NS = 'web-search-tavily'

/** Credential reference the provider resolves when the section names none. */
const DEFAULT_API_KEY_REF = 'TAVILY_API_KEY'

// ------------------------------------------------------------------ types ---

/** Field-level snapshot the scope serves. */
interface ScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  writable: boolean
  /** Raw user layer; a present field marks a user override. */
  user?: T | undefined
}

/** The bound settings scope's public face (contract-shaped). */
interface SettingsScopeLike<T> {
  getSnapshot(): ScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** What the card edits — a subset of the served schema by design. */
interface TavilySettings {
  apiKeyEnv?: string
  searchDepth?: 'basic' | 'advanced'
  maxResults?: number
  includeAnswer?: boolean
  days?: number
}

/** Snapshots the card consumes (destructured subset of the runtime store). */
interface SnapshotStoreLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The card's own publish handle; the runtime store is wider. */
interface CardStore<T> extends SnapshotStoreLike<T> {
  set(next: T): void
}

/** One Remote call's result, as the generated client face resolves it. */
type RemoteResultLike<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

/** The credentials remote namespace the section's key reference is addressed on. */
interface CredentialsRemoteLike {
  describe(refs: string[]): Promise<
    RemoteResultLike<Record<string, { configured?: boolean; writable?: boolean } | undefined>>
  >
  set(ref: string, value: string): Promise<RemoteResultLike<unknown>>
}

/** Structural client context (duck-typed; the runtime's real face is wider). */
interface ClientContextLike {
  effect(fn: () => void | (() => void), label?: string): () => void
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: {
      name: string
      key?: string
      id?: string
      order?: number
      priority?: number
      inject?: () => Record<string, unknown>
    }, component: unknown): () => void
  }
  settingsScope: {
    bind<T>(spec: { namespace: string }): SettingsScopeLike<T>
  }
  remote: {
    credentials: CredentialsRemoteLike
  }
}

/** One staged text/number field. */
interface FieldState {
  /** Effective value the Host resolves (plain editing display). */
  effective: string
  /** User-staged literal; equals `effective` when untouched. */
  staged: string
  /** Whether the user layer overrides this field. */
  overridden: boolean
}

/** The credential control's state (the key never rides a response). */
interface CredentialState {
  /** Whether the Host reports a credential configured for the referenced key. */
  configured: boolean
  /** Whether the credentials domain accepts a write for it. */
  writable: boolean
}

/** What the card renders. */
interface TavilyCardState {
  /** False while the Host serves no section under NS. */
  available: boolean
  /** False when the Host document is read-only. */
  writable: boolean
  /** True while a save is in flight. */
  saving: boolean
  /** True after a save failed. */
  failed: boolean
  /** Whether any staged edit differs from the effective section. */
  dirty: boolean
  /** Effective section the form derives from. */
  section: TavilySettings | undefined
  searchDepth: FieldState
  maxResults: FieldState
  includeAnswer: FieldState
  days: FieldState
  apiKey: CredentialState
}

/** The registration-side face the card's slot entry injects. */
interface TavilyCardFace {
  hooks: { tavilyCard: SnapshotStoreLike<TavilyCardState> }
  edit(field: string, raw: string): void
  resetField(field: string): void
  save(): Promise<void>
  discard(): void
}

type Translate = (key: string) => string

// ------------------------------------------------------------------ copy ---

const zh = {
  title: 'Tavily 搜索（web-search-tavily）',
  description: 'web_search 后端：零 token 的 Tavily REST 检索，替代 DeepSeek 原生搜索模型轮次',
  expand: '显示设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '有未保存的修改',
  readOnly: '当前部署的 settings 文档为只读',
  saveFailed: '保存失败，请重试',
  apiKey: 'Tavily API key',
  apiKeyHint: '密钥写入凭据域（不落 settings 文档）。留空 = 保留现有 key。',
  apiKeyConfigured: '已配置',
  apiKeyMissing: '未配置',
  apiKeyRef: '凭据引用',
  searchDepth: '检索深度',
  searchDepthBasic: 'basic（默认，更快更省）',
  searchDepthAdvanced: 'advanced（更深入）',
  maxResults: '结果数量',
  maxResultsHint: '单次搜索返回的来源上限（1–20）',
  includeAnswer: '生成式总结（include_answer）',
  includeAnswerHint: '额外消耗 credit 与延迟；默认关闭',
  days: '仅最近 N 天',
  daysHint: '留空 = 不限时间（1–30）',
  overridden: '已覆盖默认值',
  reset: '恢复默认',
  invalidNumber: '请输入有效整数',
  invalidDays: '请输入 1–30 的整数',
}

const en: Record<string, string> = {
  title: 'Tavily search (web-search-tavily)',
  description: 'web_search backend: zero-token Tavily REST retrieval replacing the DeepSeek native-search model turn',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard changes',
  unsaved: 'Unsaved changes',
  readOnly: 'This deployment stores settings read-only.',
  saveFailed: 'Save failed, please retry',
  apiKey: 'Tavily API key',
  apiKeyHint: 'Stored in the credentials domain (never the settings document). Leave blank to keep the current key.',
  apiKeyConfigured: 'Configured',
  apiKeyMissing: 'Not configured',
  apiKeyRef: 'Credential reference',
  searchDepth: 'Search depth',
  searchDepthBasic: 'basic (default, faster)',
  searchDepthAdvanced: 'advanced (deeper)',
  maxResults: 'Result count',
  maxResultsHint: 'Max sources per search (1–20)',
  includeAnswer: 'Generated answer (include_answer)',
  includeAnswerHint: 'Extra credit and latency; off by default',
  days: 'Last N days only',
  daysHint: 'Blank = any time (1–30)',
  overridden: 'Overridden',
  reset: 'Reset',
  invalidNumber: 'Enter a whole number',
  invalidDays: 'Enter a whole number 1–30',
}

const t: Translate = (key: string): string => zh[key] ?? en[key] ?? key

// ----------------------------------------------------------------- styles ---

const cardStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  border: '1px solid var(--dsw-alias-border, rgba(127, 127, 127, 0.3))',
  borderRadius: '12px',
  background: 'var(--dsw-surface, rgba(127, 127, 127, 0.06))',
  padding: '0',
  margin: '0',
  listStyle: 'none',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  width: '100%',
  padding: '10px 12px',
  border: '0',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
}

const bodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  padding: '0 12px 12px',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
}

const fieldStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  opacity: 0.75,
  marginBottom: 2,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 8px',
  border: '1px solid var(--dsw-alias-border, rgba(127, 127, 127, 0.3))',
  borderRadius: '6px',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
}

const hintStyle: React.CSSProperties = { display: 'block', fontSize: 11, opacity: 0.6, marginTop: 2 }

const badgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: 11,
  padding: '1px 8px',
  borderRadius: '999px',
  border: '1px solid var(--dsw-alias-border, rgba(127, 127, 127, 0.3))',
  opacity: 0.85,
}

const footerStyle: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: '8px' }

const buttonStyle: React.CSSProperties = {
  padding: '5px 14px',
  border: '1px solid var(--dsw-alias-border, rgba(127, 127, 127, 0.3))',
  borderRadius: '8px',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
}

const saveStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'var(--dsw-accent, #4c8dff)',
  borderColor: 'transparent',
  color: '#fff',
  fontWeight: 600,
}

const resetLinkStyle: React.CSSProperties = {
  border: '0',
  background: 'none',
  color: 'inherit',
  opacity: 0.6,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
  textDecoration: 'underline',
}

// ------------------------------------------------------------------ card ---

interface TavilyCardProps {
  useTavilyCard<T>(selector: (snapshot: TavilyCardState) => T): T
  edit(field: string, raw: string): void
  resetField(field: string): void
  save(): Promise<void>
  discard(): void
}

/**
 * One form row: label + hint + control + reset. Pure createElement, no JSX.
 */
function Field({
  label, hint, value, overridden, disabled,
  onChange, onReset, control, options, tag,
}: {
  label: string
  hint?: string
  value: string
  overridden?: boolean
  disabled: boolean
  onChange: (raw: string) => void
  onReset: () => void
  control: 'text' | 'number' | 'select'
  options?: readonly string[]
  tag?: string
}) {
  const choices = control === 'select' ? (options ?? ['basic', 'advanced']) : undefined
  const controlEl = control === 'select'
    ? React.createElement('select', {
      style: inputStyle,
      value,
      disabled,
      onChange: (event: { target: { value: string } }) => { onChange(event.target.value) },
    }, choices!.map(option => React.createElement('option', { key: option, value: option }, option)))
    : React.createElement('input', {
      style: inputStyle,
      type: control === 'number' ? 'number' : 'text',
      value,
      disabled,
      'aria-label': label,
      onChange: (event: { target: { value: string } }) => { onChange(event.target.value) },
    })
  return React.createElement(
    'div',
    { style: fieldStyle },
    React.createElement('label', { style: labelStyle }, label),
    controlEl,
    hint === undefined ? null : React.createElement('span', { style: hintStyle }, hint),
    React.createElement('div', { style: rowStyle },
      overridden === true
        ? React.createElement('span', { style: { fontSize: 11, opacity: 0.6 } }, `${t('overridden')} · ${tag ?? ''}`)
        : null,
      React.createElement('button', { type: 'button', style: resetLinkStyle, onClick: onReset }, t('reset'))),
  )
}

/**
 * Render the Tavily provider card. Renders nothing while the Host serves no
 * section under NS (a deployment without the plugin should show no trace).
 */
export function TavilyCard(props: TavilyCardProps) {
  const state = props.useTavilyCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  if (!state.available) return null
  const disabled = !state.writable
  const blocked = !state.dirty || state.saving
  return React.createElement(
    'li',
    { style: cardStyle },
    React.createElement(
      'button',
      {
        type: 'button',
        style: headerStyle,
        'aria-expanded': open,
        onClick: () => { setOpen(!open) },
      },
      React.createElement('span', {
        style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      },
      React.createElement('span', { style: { fontWeight: 600 } }, t('title')),
      React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, t('description'))),
      React.createElement('span', { style: rowStyle },
        state.dirty ? React.createElement('span', { style: { ...badgeStyle, color: '#e5a50a' } }, t('unsaved')) : null,
        React.createElement('span', { style: { opacity: 0.7 } }, open ? '▾' : '▸')),
    ),
    open
      ? React.createElement(
        'div',
        { style: bodyStyle },
        !state.writable ? React.createElement('p', { role: 'status', style: { margin: 0, fontSize: 12, opacity: 0.7 } }, t('readOnly')) : null,
        // credential control (the key itself never rides a response)
        React.createElement('div', { style: fieldStyle },
          React.createElement('label', { style: labelStyle }, t('apiKey')),
          React.createElement('div', { style: rowStyle },
            React.createElement('input', {
              style: { ...inputStyle, flex: 1 },
              type: 'password',
              placeholder: t('apiKeyHint'),
              disabled: disabled || !state.apiKey.writable,
              'aria-label': t('apiKey'),
              onChange: (event: { target: { value: string } }) => { props.edit('apiKey', event.target.value) },
            }),
            React.createElement('span', { style: badgeStyle },
              state.apiKey.configured ? t('apiKeyConfigured') : t('apiKeyMissing'))),
          React.createElement('span', { style: hintStyle }, t('apiKeyHint'))),
        React.createElement(Field, {
          label: `${t('searchDepth')}`, hint: state.section?.searchDepth === 'advanced' ? t('searchDepthAdvanced') : t('searchDepthBasic'),
          value: state.searchDepth.staged, disabled, control: 'select',
          onChange: (raw) => { props.edit('searchDepth', raw) },
          onReset: () => { props.resetField('searchDepth') },
          overridden: state.searchDepth.overridden,
          tag: state.searchDepth.effective,
        }),
        React.createElement(Field, {
          label: t('maxResults'), hint: t('maxResultsHint'),
          value: state.maxResults.staged, disabled, control: 'number',
          onChange: (raw) => { props.edit('maxResults', raw) },
          onReset: () => { props.resetField('maxResults') },
          overridden: state.maxResults.overridden,
          tag: state.maxResults.effective,
        }),
        React.createElement(Field, {
          label: t('includeAnswer'), hint: t('includeAnswerHint'),
          value: state.includeAnswer.staged, disabled,
          control: 'select', options: ['false', 'true'],
          onChange: (raw) => { props.edit('includeAnswer', raw) },
          onReset: () => { props.resetField('includeAnswer') },
          overridden: state.includeAnswer.overridden,
          tag: state.includeAnswer.effective,
        }),
        React.createElement(Field, {
          label: t('days'), hint: t('daysHint'),
          value: state.days.staged, disabled, control: 'number',
          onChange: (raw) => { props.edit('days', raw) },
          onReset: () => { props.resetField('days') },
          overridden: state.days.overridden,
          tag: state.days.effective,
        }),
        React.createElement('div', { style: footerStyle },
          state.failed ? React.createElement('p', { role: 'status', style: { margin: 0, fontSize: 12, color: '#e57373' } }, t('saveFailed')) : null,
          React.createElement('button', {
            type: 'button',
            style: buttonStyle,
            disabled: !state.dirty || state.saving,
            onClick: () => { props.discard() },
          }, t('discard')),
          React.createElement('button', {
            type: 'button',
            style: saveStyle,
            disabled: blocked,
            onClick: () => { void props.save() },
          }, state.saving ? t('saving') : t('save'))),
      )
      : null,
  )
}

// ------------------------------------------------------------ controller ---

/**
 * Bridges the `web-search-tavily` scope and the credentials domain onto the
 * card. Field edits stage locally and commit on Save as revision-fenced
 * section writes; the key is written to the credentials domain, never the
 * section.
 */
class TavilyCardController {
  private readonly store: SnapshotStoreLike<TavilyCardState>
  private stage: Record<string, string> = {}
  private dirtyKeys = new Set<string>()
  private saving = false
  private failed = false
  private loaded = false
  private credential = { configured: false, writable: true }

  constructor(
    private readonly scope: SettingsScopeLike<TavilySettings>,
    private readonly credentials: CredentialsRemoteLike,
  ) {
    this.store = this.makeStore()
    this.publish()
    scope.subscribe(() => {
      this.stage = {}
      this.dirtyKeys = new Set()
      this.publish()
      void this.readCredential()
    })
    void this.readCredential()
  }

  private makeStore(): CardStore<TavilyCardState> {
    let snapshot = this.projection()
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: (next: TavilyCardState) => {
        snapshot = next
        for (const listener of listeners) listener()
      },
    }
  }

  private field(key: keyof TavilySettings): FieldState {
    const snap = this.scope.getSnapshot()
    const value = snap.value
    const effective = renderField(key, value)
    const staged = this.stage[key] ?? ''
    const touched = this.dirtyKeys.has(key) || this.stage[key] !== undefined
    return {
      effective,
      staged: touched ? staged : effective,
      overridden: isOverridden(key, snap),
    }
  }

  private projection(): TavilyCardState {
    const snap = this.scope.getSnapshot()
    const available = snap.status === 'ready'
    return {
      available,
      writable: snap.writable,
      saving: this.saving,
      failed: this.failed,
      dirty: this.dirtyKeys.size > 0,
      section: snap.value,
      searchDepth: this.field('searchDepth'),
      maxResults: this.field('maxResults'),
      includeAnswer: this.field('includeAnswer'),
      days: this.field('days'),
      apiKey: this.credential,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  /** Stage one edit; a raw equal to the effective value is not dirty. */
  edit(field: string, raw: string): void {
    if (field === 'apiKey') {
      this.stage.apiKey = raw
      if (raw.length > 0) this.dirtyKeys.add('apiKey')
      else this.dirtyKeys.delete('apiKey')
      this.publish()
      return
    }
    this.stage[field] = raw
    const effective = this.field(field as keyof TavilySettings).effective
    if (raw === effective) this.dirtyKeys.delete(field)
    else this.dirtyKeys.add(field)
    this.publish()
  }

  resetField(field: string): void {
    if (field === 'apiKey') {
      delete this.stage.apiKey
      this.dirtyKeys.delete('apiKey')
      this.publish()
      return
    }
    delete this.stage[field]
    this.dirtyKeys.delete(field)
    this.publish()
  }

  discard(): void {
    this.stage = {}
    this.dirtyKeys = new Set()
    this.failed = false
    this.publish()
  }

  /** Commit every staged edit; the key goes to the credentials domain. */
  async save(): Promise<void> {
    const writes: Array<Promise<unknown>> = []
    for (const key of [...this.dirtyKeys]) {
      if (key === 'apiKey') {
        const value = this.stage.apiKey ?? ''
        if (value.length > 0) {
          writes.push(this.credentials.set(this.ref(), value).catch(() => undefined))
        }
        continue
      }
      const raw = this.stage[key] ?? ''
      if (key === 'includeAnswer') {
        if (raw === '') continue
        writes.push(this.scope.set(key, raw === 'true'))
        continue
      }
      if (raw === '') {
        writes.push(this.scope.unset(key))
        continue
      }
      const numeric = parseNumber(raw)
      if (key === 'days' && (numeric === undefined || numeric < 1 || numeric > 30)) continue
      if (key === 'maxResults' && (numeric === undefined || numeric < 1)) continue
      if (numeric !== undefined) writes.push(this.scope.set(key, numeric))
    }
    if (writes.length === 0) {
      this.dirtyKeys = new Set()
      this.publish()
      return
    }
    this.saving = true
    this.failed = false
    this.publish()
    try {
      await Promise.all(writes)
    } catch (_saveFailure) {
      this.failed = true
    }
    this.saving = false
    this.stage = {}
    this.dirtyKeys = new Set()
    await this.readCredential()
    this.publish()
  }

  /** The credential reference the section names, or the provider default. */
  private ref(): string {
    const declared = this.scope.getSnapshot().value?.apiKeyEnv
    return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
  }

  /** Ask the credentials domain about the reference the section currently names. */
  private async readCredential(): Promise<void> {
    try {
      const response = await this.credentials.describe([this.ref()])
      if (!response.ok) return
      const view = response.value[this.ref()]
      const next = {
        configured: view?.configured ?? false,
        writable: view?.writable ?? true,
      }
      if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
      this.credential = next
      this.publish()
    } catch (_credentialReadFailure) {
      // The card stays usable without this: the key control simply reports the
      // last state it knew, and a write still reaches the Host.
    }
  }

  /** Build the face the card's slot registration injects. */
  inject(): TavilyCardFace {
    return {
      hooks: { tavilyCard: this.store },
      edit: (field, raw) => { this.edit(field, raw) },
      resetField: (field) => { this.resetField(field) },
      save: () => this.save(),
      discard: () => { this.discard() },
    }
  }
}

// ---------------------------------------------------------------- helpers ---

/** Render one section field as its text representation. */
function renderField(key: keyof TavilySettings, value: TavilySettings | undefined): string {
  if (value === undefined) return ''
  const raw = value[key]
  if (raw === undefined) return ''
  if (key === 'includeAnswer') return raw ? 'true' : 'false'
  return String(raw)
}

/** Whether the user layer overrides one field (presence marks an override). */
function isOverridden(key: keyof TavilySettings, snap: ScopeSnapshot<TavilySettings>): boolean {
  const user = snap.user
  if (user === undefined) return false
  return user[key] !== undefined && key !== 'apiKeyEnv'
}

/** Parse a numeric field literal. */
function parseNumber(raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) && Number.isInteger(value) ? value : undefined
}

// ------------------------------------------------------------------- apply ---

export const inject = ['slots', 'settingsScope', 'remote', 'remote.credentials']

export function apply(ctx: ClientContextLike): void {
  const scope = ctx.settingsScope.bind<TavilySettings>({ namespace: NS })
  const controller = new TavilyCardController(scope, ctx.remote.credentials)
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NS,
    inject: () => controller.inject(),
  }, TavilyCard))
}