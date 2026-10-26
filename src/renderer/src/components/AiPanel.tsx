import { useCallback, useEffect, useState } from 'react'
import type { AppState } from '@shared/types'
import type { AiStatus } from '@shared/ai/status'
import type { PullProgress } from '@shared/ai/pull'
import type { AiSettings } from '@shared/ai/settings'
import { fmtBytes, fmtCount } from '../lib/format'

interface Props {
  unclassified: number
  onClose: () => void
  onApplied: (state: AppState) => void
}

const FIT_LABEL: Record<string, string> = {
  comfortable: 'Fits',
  tight: 'Tight',
  'fits-cpu': 'CPU only',
  'wont-fit': "Won't fit"
}

export function AiPanel({ unclassified, onClose, onApplied }: Props): React.JSX.Element {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [pull, setPull] = useState<(PullProgress & { model: string }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [other, setOther] = useState('')

  const refresh = useCallback(async () => {
    const next = await window.dsa.aiStatus()
    setStatus(next)
    setSettings(next.settings)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => window.dsa.onPullProgress((p) => setPull(p)), [])
  useEffect(() => window.dsa.onAiProgress((p) => setStage(`${p.stage} ${p.done}/${p.total}`)), [])

  const persist = useCallback(async (next: AiSettings, key?: string) => {
    setSettings(next)
    await window.dsa.aiSaveSettings(next, key)
  }, [])

  const download = async (model: string): Promise<void> => {
    setError(null)
    setPull({ model, status: 'starting', completed: 0, total: 0, done: false })
    try {
      await window.dsa.aiPull(model)
      await refresh()
      if (settings) await persist({ ...settings, localModel: model, enabled: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPull(null)
    }
  }

  const use = async (model: string): Promise<void> => {
    if (!settings) return
    await persist({ ...settings, localModel: model, enabled: true })
  }

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setStage('starting')
    try {
      const result = await window.dsa.aiRun()
      onApplied(result.state)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  if (!status || !settings) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <h2>Local AI</h2>
            <button className="btn tiny ghost" onClick={onClose}>
              Close
            </button>
          </div>
          <p className="modal-sub">Reading hardware and installed models…</p>
        </div>
      </div>
    )
  }

  const hw = status.hardware
  const selectedInstalled = status.installed.some(
    (m) => m.name === settings.localModel || m.name === `${settings.localModel}:latest`
  )
  const selectedRec = status.recommendations.find((r) => r.spec.id === settings.localModel)
  // A model from the catalogue that this machine cannot hold is a hard no.
  // A custom tag is allowed through: the main-process preflight still refuses it.
  const canRun = selectedInstalled && (!selectedRec || selectedRec.fit !== 'wont-fit')

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal ai-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Local AI</h2>
          <button className="btn tiny ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="ai-body">
          <section className="ai-hw">
            <div>
              <span className="stat-k">GPU</span>
              <span className="stat-v ai-small">
                {hw.gpuName ?? 'Not detected — CPU only'}
              </span>
            </div>
            <div>
              <span className="stat-k">VRAM free</span>
              <span className="stat-v ai-small">
                {hw.vramFreeBytes === null
                  ? 'unknown'
                  : `${fmtBytes(hw.vramFreeBytes)} of ${fmtBytes(hw.vramTotalBytes ?? 0)}`}
              </span>
            </div>
            <div>
              <span className="stat-k">RAM free</span>
              <span className="stat-v ai-small">
                {fmtBytes(hw.ramFreeBytes)} of {fmtBytes(hw.ramTotalBytes)}
              </span>
            </div>
          </section>

          {!status.ollamaReachable && (
            <div className="ai-warn">
              <strong>Ollama is not running.</strong> Local AI needs it as the runtime — it is a
              separate install, and this app does not bundle a model.
              <div className="ai-warn-actions">
                <button
                  className="btn tiny"
                  onClick={() => window.open('https://ollama.com/download', '_blank')}
                >
                  Get Ollama
                </button>
                <button className="btn tiny ghost" onClick={() => void refresh()}>
                  Check again
                </button>
              </div>
            </div>
          )}

          {status.ollamaReachable && status.recommendations.every((r) => r.fit === 'wont-fit') && (
            <div className="ai-warn">
              <strong>Not enough free memory right now.</strong> The model runner needs about
              1.5 GB of RAM on top of the model itself, and {fmtBytes(hw.ramFreeBytes)} is free.
              Close some apps, then check again — nothing here will run until there is room.
              <div className="ai-warn-actions">
                <button className="btn tiny ghost" onClick={() => void refresh()}>
                  Check again
                </button>
              </div>
            </div>
          )}

          <div className="ai-section">
            <div className="ai-section-head">
              <span>Models for this machine</span>
              <span className="muted">sizes are estimates until downloaded</span>
            </div>

            {status.recommendations.map((rec) => {
              const isSelected = settings.localModel === rec.spec.id
              const downloading = pull?.model === rec.spec.id
              const pct = pull && pull.total > 0 ? Math.min(100, (pull.completed / pull.total) * 100) : 0

              return (
                <div key={rec.spec.id} className={`ai-model ${isSelected ? 'selected' : ''}`}>
                  <div className="ai-model-main">
                    <div className="ai-model-title">
                      <span className="row-name">{rec.spec.label}</span>
                      <span className={`fit-badge fit-${rec.fit}`}>{FIT_LABEL[rec.fit]}</span>
                      {rec.installed && <span className="tag">installed</span>}
                      {isSelected && <span className="tag t-LOCKED">selected</span>}
                      <span className="mono muted ai-size">{fmtBytes(rec.spec.sizeBytes)}</span>
                    </div>
                    <div className="ai-model-note">{rec.spec.note}</div>
                    <div className="ai-model-detail">{rec.detail}</div>
                    {downloading && (
                      <div className="ai-progress">
                        <div className="ai-progress-bar">
                          <i style={{ width: `${pct}%` }} />
                        </div>
                        <span className="mono">
                          {pull.status} {pull.total > 0 ? `· ${pct.toFixed(0)}%` : ''}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="ai-model-actions">
                    {rec.installed ? (
                      <button className="btn tiny" disabled={isSelected} onClick={() => void use(rec.spec.id)}>
                        {isSelected ? 'In use' : 'Use'}
                      </button>
                    ) : (
                      <button
                        className="btn tiny primary"
                        disabled={!!pull || rec.fit === 'wont-fit'}
                        onClick={() => void download(rec.spec.id)}
                      >
                        Download
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="ai-section">
            <div className="ai-section-head">
              <span>Other model</span>
              <span className="muted">any Ollama tag you already have</span>
            </div>
            <div className="ai-other">
              <input
                value={other}
                onChange={(e) => setOther(e.target.value)}
                placeholder="e.g. gemma3:4b"
                spellCheck={false}
              />
              <button
                className="btn tiny"
                disabled={!other.trim()}
                onClick={() => {
                  void use(other.trim())
                  setOther('')
                }}
              >
                Use
              </button>
            </div>
          </div>

          <div className="ai-section">
            <div className="ai-section-head">
              <span>Provider</span>
            </div>
            <div className="ai-provider">
              <select
                value={settings.provider}
                onChange={(e) =>
                  void persist({ ...settings, provider: e.target.value as AiSettings['provider'] })
                }
              >
                <option value="local">Local only — nothing leaves this machine</option>
                <option value="hybrid">Hybrid — escalate low-confidence folders to cloud</option>
              </select>
            </div>

            {settings.provider === 'hybrid' && (
              <div className="ai-cloud">
                <p className="muted ai-cloud-note">
                  Only the folder path, size, file count and date are sent — never file contents.
                  Low-confidence results below {settings.confidenceThreshold} are escalated.
                </p>
                <input
                  value={settings.cloud.baseUrl}
                  onChange={(e) =>
                    setSettings({ ...settings, cloud: { ...settings.cloud, baseUrl: e.target.value } })
                  }
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                />
                <input
                  value={settings.cloud.model}
                  onChange={(e) =>
                    setSettings({ ...settings, cloud: { ...settings.cloud, model: e.target.value } })
                  }
                  placeholder="model name, e.g. gpt-4o-mini"
                  spellCheck={false}
                />
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={status.keyPresent ? 'key saved — paste to replace' : 'API key'}
                />
                <button
                  className="btn tiny"
                  onClick={() => void persist(settings, apiKey)}
                  disabled={!settings.cloud.model}
                >
                  Save cloud settings
                </button>
              </div>
            )}
          </div>

          {error && <div className="ai-error">{error}</div>}
        </div>

        <div className="modal-foot">
          <span className="muted">
            {unclassified > 0
              ? `${fmtCount(unclassified)} folders no rule could classify`
              : 'Every folder is covered by a rule'}
          </span>
          <div className="foot-actions">
            <button className="btn ghost" onClick={onClose} disabled={busy}>
              Close
            </button>
            <button
              className="btn primary"
              disabled={busy || unclassified === 0 || !canRun}
              onClick={() => void run()}
            >
              {busy ? stage ?? 'Classifying…' : `Classify ${fmtCount(unclassified)} folders`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
