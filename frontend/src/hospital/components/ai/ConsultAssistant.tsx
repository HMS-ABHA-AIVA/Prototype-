import { useEffect, useRef, useState } from 'react';
import {
  fetchAiStatus, sortDictation, suggestPrescription,
  type AiStatus, type DictationResult, type Frequency, type NoteFields, type PrescriptionSuggestion, type SuggestionResult,
} from '../../api/ai';
import { LANGUAGES, listeningSupported, speak, speakingSupported, startListening, stopSpeaking, type Listener } from '../../utils/speech';
import { reportError, useNoticeStore } from '../../store/useNoticeStore';
import { Badge } from '../ui/Badge';

const FREQUENCY_WORDS: Record<Frequency, string> = {
  OD: 'once a day', BD: 'twice a day', TDS: 'three times a day', QID: 'four times a day', SOS: 'only when needed',
};
const FIELD_LABELS: Record<keyof NoteFields, string> = { subjective: 'Subjective', objective: 'Objective', assessment: 'Assessment', plan: 'Plan' };

interface Row extends PrescriptionSuggestion {
  checked: boolean;
}

export interface AssistantProps {
  encounterId: string;
  /** The note as it is on screen right now (it need not be saved). */
  note: NoteFields;
  /** Put dictated text into the note boxes (the page appends it to what is already there). */
  onFillNote: (sections: Partial<NoteFields>) => void;
  onRecordVitals: (v: { temp: number; pulse: number; bp: string; spo2: number; rr: number }) => void;
  onAddOrder: (order: { type: 'lab' | 'radiology'; name: string }) => void;
  onAddPrescription: (rx: { drugName: string; dose: string; frequency: string; duration: string; aiSuggested: boolean }) => void;
}

/**
 * The doctor's AI assistant for a consultation. Speak (or type) what you found; it is sorted into the right note fields;
 * ask for a suggested prescription; read things back aloud. Everything it produces is a DRAFT for the doctor to look at,
 * change and choose from: nothing reaches the patient's record until the doctor clicks to add it.
 */
export function ConsultAssistant({ encounterId, note, onFillNote, onRecordVitals, onAddOrder, onAddPrescription }: AssistantProps) {
  const [lang, setLang] = useState<string>(LANGUAGES[0].code);
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [busy, setBusy] = useState<'sort' | 'suggest' | null>(null);
  const [heard, setHeard] = useState<DictationResult | null>(null);
  const [offer, setOffer] = useState<SuggestionResult | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState<AiStatus | null>(null);

  const listener = useRef<Listener | null>(null);
  const base = useRef('');

  // Never leave the microphone or the speaker running when the doctor leaves the screen.
  useEffect(() => () => { listener.current?.stop(); stopSpeaking(); }, []);

  // Learn once whether the AI is on and whether its provider may read what is sent; a failure just means no banner.
  useEffect(() => { fetchAiStatus().then(setStatus).catch(() => setStatus(null)); }, []);

  function toggleListening() {
    if (listening) {
      listener.current?.stop();
      return;
    }
    setProblem(null);
    base.current = transcript.trim();
    const started = startListening({
      lang,
      onText: (final, partial) => {
        setTranscript([base.current, final].filter(Boolean).join(' '));
        setInterim(partial);
      },
      onProblem: (message) => setProblem(message),
      onStopped: () => {
        setListening(false);
        setInterim('');
        listener.current = null;
      },
    });
    if (started) {
      listener.current = started;
      setListening(true);
    }
  }

  async function sortIntoNote() {
    const text = [transcript, interim].filter(Boolean).join(' ').trim();
    if (!text) return;
    listener.current?.stop();
    setBusy('sort');
    try {
      const result = await sortDictation(encounterId, text);
      onFillNote(result.sections);
      setHeard(result);
      setTranscript('');
      setInterim('');
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }

  async function suggest() {
    setBusy('suggest');
    setOffer(null);
    try {
      const result = await suggestPrescription(encounterId, note);
      setOffer(result);
      // Anything the system flagged starts unticked: the doctor has to choose to include it.
      setRows(result.suggestions.map((s) => ({ ...s, checked: !s.allergyWarning && !s.alreadyPrescribed && s.recognised !== false })));
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }

  function addChosen() {
    let added = 0;
    for (const row of rows) {
      if (!row.checked || !row.drugName.trim() || !row.dose.trim()) continue;
      if (row.allergyWarning && !window.confirm(`${row.allergyWarning}\n\nAdd ${row.drugName} to the prescription anyway?`)) continue;
      onAddPrescription({ drugName: row.drugName.trim(), dose: row.dose.trim(), frequency: row.frequency, duration: row.duration.trim() || '5 days', aiSuggested: true });
      added++;
    }
    if (added > 0) {
      useNoticeStore.getState().show(`${added} medicine${added === 1 ? '' : 's'} added to the prescription, marked as AI-suggested. Please review them below.`, 'info');
      setOffer(null);
      setRows([]);
    } else {
      useNoticeStore.getState().show('Nothing was added: tick the medicines you want first.', 'info');
    }
  }

  const update = (index: number, change: Partial<Row>) => setRows((all) => all.map((r, i) => (i === index ? { ...r, ...change } : r)));

  function readAloud(text: string) {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    speak(text, lang, () => setSpeaking(false));
  }

  const noteText = (Object.keys(FIELD_LABELS) as (keyof NoteFields)[])
    .filter((k) => note[k].trim())
    .map((k) => `${FIELD_LABELS[k]}. ${note[k].trim()}`)
    .join(' ');
  const rowsText = rows
    .filter((r) => r.checked)
    .map((r, i) => `${i + 1}. ${r.drugName}, ${r.dose}, ${FREQUENCY_WORDS[r.frequency]}, for ${r.duration}.${r.allergyWarning ? ` Warning: ${r.allergyWarning}.` : ''}`)
    .join(' ');

  const vitalsHeard = heard ? Object.entries(heard.vitals) : [];
  const hasHeardExtras = heard && (vitalsHeard.length > 0 || heard.orders.length > 0);

  return (
    <div className="card ai-card">
      <div className="flex-between">
        <div>
          <h3>✨ AI Assistant</h3>
          <div className="card-sub">Speak the consultation, get it sorted into the note, and review a suggested prescription.</div>
        </div>
        <Badge tone="info">Drafts only</Badge>
      </div>

      {status?.demoOnly && (
        <div className="ai-demo-warning" role="alert">
          <b>Demo AI, invented patients only.</b> This server uses Google's free Gemini service, and Google's terms say its staff may read what is sent to it.
          Do not use it with real patients' details. For real use, switch the server to a paid key.
        </div>
      )}
      {status && !status.enabled && (
        <div className="ai-hint" style={{ marginBottom: 8 }}>
          Suggested prescriptions are not switched on for this hospital yet. Dictation still works, sorted by the section words you say.
        </div>
      )}

      {/* ---- Dictation ---- */}
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <button
          type="button"
          className={`btn btn-sm ${listening ? 'btn-danger' : 'btn-primary'}`}
          onClick={toggleListening}
          disabled={!listeningSupported()}
          aria-pressed={listening}
        >
          {listening ? <><span className="mic-live" /> Stop listening</> : <>🎤 Start dictation</>}
        </button>
        <select value={lang} onChange={(e) => setLang(e.target.value)} style={{ maxWidth: 170 }} aria-label="Language" disabled={listening}>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
        {speakingSupported() && (
          <button type="button" className="btn btn-sm" onClick={() => readAloud(noteText)} disabled={!noteText && !speaking}>
            {speaking ? '⏹ Stop reading' : '🔊 Read note aloud'}
          </button>
        )}
      </div>
      {!listeningSupported() && (
        <div className="ai-hint">Voice dictation needs Chrome or Edge on a computer. You can still type or paste what was said below.</div>
      )}
      {problem && <div className="login-error" role="alert">{problem}</div>}

      <div className="field" style={{ marginBottom: 8 }}>
        <label htmlFor="ai-transcript">What you said {listening && <span className="ai-live">· listening…</span>}</label>
        <textarea
          id="ai-transcript"
          rows={3}
          value={interim ? `${transcript}${transcript ? ' ' : ''}${interim}` : transcript}
          onChange={(e) => { setTranscript(e.target.value); setInterim(''); }}
          readOnly={listening}
          placeholder={'Say or type, e.g. "Subjective: fever for two days. Objective: throat congested, temperature 100.6. Assessment: viral fever. Plan: rest, fluids, paracetamol."'}
        />
        <div className="ai-hint">Tip: saying the words Subjective, Objective, Assessment and Plan helps it put each part in the right box. In Chrome and Edge the browser sends the audio to its own speech service to turn it into text; nothing is recorded here.</div>
      </div>
      <div className="row" style={{ marginBottom: 6 }}>
        <button type="button" className="btn btn-sm btn-primary" onClick={sortIntoNote} disabled={busy !== null || !(transcript.trim() || interim.trim())}>
          {busy === 'sort' ? 'Sorting…' : 'Put into note fields'}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setTranscript(''); setInterim(''); }} disabled={listening || !transcript}>Clear</button>
      </div>

      {heard && (
        <div className="ai-result">
          <div style={{ fontSize: 12.5 }}>
            ✅ Placed in the note:{' '}
            <b>{(Object.keys(FIELD_LABELS) as (keyof NoteFields)[]).filter((k) => heard.sections[k]).map((k) => FIELD_LABELS[k]).join(', ') || 'nothing'}</b>
            <span style={{ color: 'var(--ink-soft)' }}>
              {' '}· {heard.source === 'ai' ? 'sorted by the AI' : 'sorted by the section words you said (the AI is not switched on)'}. Check the boxes below, then press Save Note.
            </span>
          </div>
          {hasHeardExtras && (
            <div className="stack" style={{ marginTop: 8 }}>
              {vitalsHeard.length > 0 && (
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5 }}>
                    Vitals heard:{' '}
                    <span className="mono">
                      {[heard.vitals.tempF && `T ${heard.vitals.tempF}°F`, heard.vitals.pulse && `P ${heard.vitals.pulse}`, heard.vitals.bp && `BP ${heard.vitals.bp}`, heard.vitals.spo2 && `SpO2 ${heard.vitals.spo2}%`, heard.vitals.rr && `RR ${heard.vitals.rr}`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      onRecordVitals({ temp: heard.vitals.tempF ?? 0, pulse: heard.vitals.pulse ?? 0, bp: heard.vitals.bp ?? '', spo2: heard.vitals.spo2 ?? 0, rr: heard.vitals.rr ?? 0 });
                      setHeard({ ...heard, vitals: {} });
                    }}
                  >
                    Record these vitals
                  </button>
                </div>
              )}
              {heard.orders.map((o) => (
                <div className="row" key={`${o.type}-${o.name}`}>
                  <span style={{ fontSize: 12.5 }}>Test heard: <b>{o.name}</b> <Badge tone="neutral">{o.type}</Badge></span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => { onAddOrder(o); setHeard({ ...heard, orders: heard.orders.filter((x) => x !== o) }); }}
                  >
                    Add order
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- Suggested prescription ---- */}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10 }}>
        <button type="button" className="btn btn-sm btn-primary" onClick={suggest} disabled={busy !== null}>
          {busy === 'suggest' ? 'Thinking…' : '💊 Suggest a prescription from this note'}
        </button>
        <span className="ai-hint" style={{ marginLeft: 8 }}>Uses the note as it is on screen. Only clinical details are sent, never the patient's name or phone.</span>
      </div>

      {offer && (
        <div className="ai-preview" aria-live="polite">
          <div className="flex-between">
            <h4 style={{ margin: 0 }}>Suggested prescription (preview)</h4>
            <div className="row">
              {speakingSupported() && rowsText && (
                <button type="button" className="btn btn-sm" onClick={() => readAloud(`Suggested prescription. ${rowsText}`)}>
                  {speaking ? '⏹ Stop' : '🔊 Read aloud'}
                </button>
              )}
            </div>
          </div>
          <div className="ai-disclaimer">{offer.disclaimer} You decide what to include: untick, edit or ignore any line.</div>

          {rows.length === 0 && <div className="empty-state">The AI did not find a medicine that fits this note.{offer.advice ? ` ${offer.advice}` : ''}</div>}

          {rows.map((r, i) => (
            <div key={`${r.drugName}-${i}`} className={`ai-row${r.allergyWarning ? ' danger' : ''}`}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" checked={r.checked} onChange={(e) => update(i, { checked: e.target.checked })} aria-label={`Include ${r.drugName}`} style={{ width: 'auto', marginTop: 10 }} />
                <div style={{ flex: 1 }}>
                  <div className="two-col" style={{ marginBottom: 4 }}>
                    <input value={r.drugName} onChange={(e) => update(i, { drugName: e.target.value })} aria-label="Drug name" />
                    <input value={r.dose} onChange={(e) => update(i, { dose: e.target.value })} aria-label="Dose" />
                    <select value={r.frequency} onChange={(e) => update(i, { frequency: e.target.value as Frequency })} aria-label="Frequency">
                      <option>OD</option><option>BD</option><option>TDS</option><option>QID</option><option>SOS</option>
                    </select>
                    <input value={r.duration} onChange={(e) => update(i, { duration: e.target.value })} aria-label="Duration" />
                  </div>
                  {r.rationale && <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{r.rationale}</div>}
                  <div className="row" style={{ flexWrap: 'wrap', marginTop: 4, gap: 6 }}>
                    {r.allergyWarning && <Badge tone="danger">⚠ {r.allergyWarning}</Badge>}
                    {r.alreadyPrescribed && <Badge tone="warn">Already on this prescription</Badge>}
                    {r.recognised === false && <Badge tone="warn">Name not found in the drug lists. Check it</Badge>}
                    {r.pharmacy.listed
                      ? <Badge tone={(r.pharmacy.stock ?? 0) > 0 ? 'ok' : 'warn'}>Pharmacy: {r.pharmacy.stock ?? 0} {r.pharmacy.unit ?? ''} in stock</Badge>
                      : <Badge tone="neutral">Not in the pharmacy list</Badge>}
                  </div>
                </div>
              </div>
            </div>
          ))}

          {offer.advice && rows.length > 0 && <div style={{ fontSize: 12.5, margin: '8px 0' }}><b>Advice:</b> {offer.advice}</div>}

          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setOffer(null); setRows([]); stopSpeaking(); setSpeaking(false); }}>Discard</button>
            {rows.length > 0 && (
              <button type="button" className="btn btn-primary btn-sm" onClick={addChosen} disabled={!rows.some((r) => r.checked)}>
                Add ticked medicines to the prescription
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
