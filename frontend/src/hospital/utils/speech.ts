/**
 * Voice in and voice out, using what the browser already provides (no extra software, no cost):
 *  - listening ("speech to text") works in Chrome and Edge; Firefox and Safari do not offer it to web pages;
 *  - speaking ("text to speech") works in all current browsers.
 *
 * Privacy: in Chrome and Edge the browser itself sends the audio to its maker's speech service to be turned into text.
 * Nothing is recorded or kept by this application: only the text, which the doctor can edit before using it.
 */

interface RecognitionEvent {
  resultIndex: number
  results: { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } }
}
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionConstructor = new () => Recognition

function recognitionConstructor(): RecognitionConstructor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const listeningSupported = () => recognitionConstructor() !== null
export const speakingSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window

export const LANGUAGES = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-US', label: 'English (US)' },
] as const

/** What went wrong, in words a doctor can act on. */
export function listeningProblem(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'The microphone is blocked. Allow microphone access for this site in the browser, then try again.'
    case 'audio-capture':
      return 'No microphone was found. Connect one and try again.'
    case 'network':
      return 'Speech recognition needs an internet connection. Check the connection and try again.'
    case 'language-not-supported':
      return 'This browser cannot listen in that language. Pick another language.'
    default:
      return `Listening stopped (${code}). You can start again, or type the note.`
  }
}

export interface Listener {
  stop(): void
}

/**
 * Starts listening. `onText` gets the words recognised so far in this sitting: `final` text is settled, `interim` is the
 * browser's current guess for the words still being spoken. The browser stops by itself after a silence, so the listener
 * restarts quietly until `stop()` is called. Returns null if this browser cannot listen.
 */
export function startListening(options: {
  lang: string
  onText: (final: string, interim: string) => void
  onProblem: (message: string) => void
  onStopped: () => void
}): Listener | null {
  const Ctor = recognitionConstructor()
  if (!Ctor) return null

  let wanted = true
  let settled = ''
  let recognition = create()

  function create(): Recognition {
    const r = new Ctor!()
    r.lang = options.lang
    r.continuous = true
    r.interimResults = true
    r.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i]![0].transcript
        if (event.results[i]!.isFinal) settled += (settled && !settled.endsWith(' ') ? ' ' : '') + piece.trim()
        else interim += piece
      }
      options.onText(settled, interim)
    }
    r.onerror = (event) => {
      // "no-speech" and "aborted" are normal pauses, not failures.
      if (event.error === 'no-speech' || event.error === 'aborted') return
      wanted = false
      options.onProblem(listeningProblem(event.error))
    }
    r.onend = () => {
      if (wanted) {
        try {
          recognition = create()
          recognition.start()
          return
        } catch {
          wanted = false
        }
      }
      options.onStopped()
    }
    return r
  }

  try {
    recognition.start()
  } catch {
    options.onProblem('Could not start the microphone. Try again.')
    return null
  }
  return {
    stop() {
      wanted = false
      recognition.stop()
    },
  }
}

// ---- speaking ----------------------------------------------------------------------------------------------------------

/** Reads text aloud in the given language, using a matching installed voice when there is one. Replaces anything already being read. */
export function speak(text: string, lang: string, onDone?: () => void): void {
  if (!speakingSupported()) return
  const synth = window.speechSynthesis
  synth.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = lang
  const voice = synth.getVoices().find((v) => v.lang === lang) ?? synth.getVoices().find((v) => v.lang.startsWith(lang.slice(0, 2)))
  if (voice) utterance.voice = voice
  utterance.rate = 0.95
  utterance.onend = () => onDone?.()
  utterance.onerror = () => onDone?.()
  synth.speak(utterance)
}

export function stopSpeaking(): void {
  if (speakingSupported()) window.speechSynthesis.cancel()
}
