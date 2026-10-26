import { useState } from 'react'

interface Props {
  onFinish: () => void
}

interface Step {
  title: string
  body: string
  note?: string
}

const STEPS: Step[] = [
  {
    title: 'Nothing is deleted without you',
    body:
      'opendump reads folder sizes and sorts them into four tiers. It cannot remove anything until you tick it, review it, and confirm it twice.',
    note: 'Reading the drive is completely safe — the scanner never writes.'
  },
  {
    title: 'Scan once, then it is instant',
    body:
      'The first scan walks the whole drive and takes a couple of minutes. The result is cached, so every later launch opens immediately. You only rescan when you want fresh sizes.',
    note: 'Close heavy apps first — a scan competes with them for disk time.'
  },
  {
    title: 'Four tiers, and only one is a recommendation',
    body:
      'Green Safe regenerates itself. Amber Review needs your judgement. Blue Keep is your data, and a Keep folder protects everything inside it. Red Locked cannot even be selected.',
    note: 'If a folder mixes cache and your files, it is Review, not Safe.'
  },
  {
    title: 'Quarantine first, purge second',
    body:
      'Selected folders move to a holding area — instant, on the same drive, and restorable with one click. Space is only freed when you purge, and the confirmation lists the real filenames you are about to destroy.',
    note: 'Local AI is optional. It needs Ollama and about 1.5 GB of free RAM.'
  }
]

export function TutorialModal({ onFinish }: Props): React.JSX.Element {
  const [step, setStep] = useState(0)
  const current = STEPS[step]
  const last = step === STEPS.length - 1

  return (
    <div className="modal-backdrop">
      <div className="modal tutorial" onClick={(e) => e.stopPropagation()}>
        <div className="tutorial-body">
          <div className="tutorial-count">
            Step {step + 1} of {STEPS.length}
          </div>
          <h2>{current.title}</h2>
          <p>{current.body}</p>
          {current.note && <div className="tutorial-note">{current.note}</div>}

          <div className="tutorial-dots" aria-hidden="true">
            {STEPS.map((_, i) => (
              <span key={i} className={i === step ? 'on' : ''} />
            ))}
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onFinish}>
            Skip
          </button>
          <div className="foot-actions">
            <button className="btn ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
            <button
              className="btn primary"
              onClick={() => {
                if (last) onFinish()
                else setStep((s) => s + 1)
              }}
            >
              {last ? 'Got it' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
