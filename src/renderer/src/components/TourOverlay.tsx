import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

interface Props {
  onFinish: () => void
}

interface Step {
  /** data-tour attribute of the element to spotlight. */
  target: string
  title: string
  body: string
  /** When set, clicking this selector advances the tour — the user learns by doing. */
  advanceOn?: string
  hint?: string
}

const STEPS: Step[] = [
  {
    target: 'scan',
    title: 'Start with one scan',
    body:
      'The first scan reads folder names and sizes only — it never opens or changes a file. It takes a couple of minutes, then every later launch opens instantly from cache.',
    hint: 'Nothing on your drive is touched by scanning.'
  },
  {
    target: 'nav',
    title: 'Three views, one database',
    body:
      'Map is a treemap of the drive. Review is the ranked list of things you can act on. Quarantine holds whatever you have staged but not yet destroyed.',
    advanceOn: '[data-tour="nav-review"]',
    hint: 'Click Review to carry on →'
  },
  {
    target: 'tiers',
    title: 'Four colours, four meanings',
    body:
      'Green Safe regenerates itself. Amber Review needs your judgement. Blue Keep is your data — and a Keep folder protects everything inside it. Red Locked cannot even be selected.',
    hint: 'Filter by any tier with these chips.'
  },
  {
    target: 'quarantine',
    title: 'Deleting takes two deliberate steps',
    body:
      'Ticking a box only builds a plan. Quarantine moves the folders to a holding area — instant, restorable. Space is freed only when you purge, and that confirmation lists the real filenames.',
    hint: 'The button stays disabled until something is selected.'
  },
  {
    target: 'ai',
    title: 'A second opinion is optional',
    body:
      'Local AI can classify folders the rules could not. It needs Ollama and about 1.5 GB of free RAM, it runs entirely on your machine, and it can never authorise a deletion — the best it can say is Review.',
    hint: 'The number on the button is how many folders no rule could explain.'
  },
  {
    target: 'rules',
    title: 'The classifier is yours to edit',
    body:
      'Every verdict comes from rules/rules.json — plain JSON, no build step. Add your own in rules/overrides.json and they win. This button opens the file.',
    hint: 'That is the whole tool. Explore whenever you like — the ? button replays this.'
  }
]

export function TourOverlay({ onFinish }: Props): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [cardHeight, setCardHeight] = useState(210)

  const current = STEPS[step]

  const measure = useCallback(() => {
    const el = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`)
    setRect(el ? el.getBoundingClientRect() : null)
  }, [current.target])

  useLayoutEffect(() => {
    measure()
    if (cardRef.current) setCardHeight(cardRef.current.getBoundingClientRect().height)
  }, [measure, step])

  useEffect(() => {
    const onResize = (): void => measure()
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [measure])

  // Learn by doing: clicking the real control moves the tour forward.
  useEffect(() => {
    if (!current.advanceOn) return
    const el = document.querySelector<HTMLElement>(current.advanceOn)
    if (!el) return
    const handler = (): void => {
      window.setTimeout(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 220)
    }
    el.addEventListener('click', handler)
    return () => el.removeEventListener('click', handler)
  }, [current.advanceOn, step])

  const last = step === STEPS.length - 1
  const pad = 6

  const cardStyle: React.CSSProperties = (() => {
    if (!rect) return { left: '50%', top: '45%', transform: 'translate(-50%, -50%)' }
    const width = 380
    const gap = 16
    const below = rect.bottom + gap + cardHeight < window.innerHeight
    const top = below ? rect.bottom + gap : Math.max(16, rect.top - gap - cardHeight)
    const left = Math.min(Math.max(16, rect.left), window.innerWidth - width - 16)
    return { top, left, width }
  })()

  return (
    <div className="tour-layer">
      {rect && (
        <div
          className="tour-spot"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2
          }}
        />
      )}

      <div className="tour-card" ref={cardRef} style={cardStyle} role="dialog" aria-live="polite">
        <div className="tour-count">
          Step {step + 1} of {STEPS.length}
        </div>
        <h2>{current.title}</h2>
        <p>{current.body}</p>
        {current.hint && <div className="tour-hint">{current.hint}</div>}

        <div className="tour-actions">
          <button className="btn tiny ghost" onClick={onFinish}>
            Skip
          </button>
          <div className="tour-nav">
            <button className="btn tiny ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
            <button
              className="btn tiny primary"
              onClick={() => (last ? onFinish() : setStep((s) => s + 1))}
            >
              {last ? 'Start exploring' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
