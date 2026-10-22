import { useState } from 'react';

interface AISuggestionProps {
  label: string;
  draft: string;
  onAccept: (finalText: string) => void;
  onReject?: () => void;
  acceptLabel?: string;
}

/**
 * Shared human-in-the-loop pattern for every AI-assisted output (discharge
 * drafting, coding suggestions, etc.) per the design doc's Tier-2 AI
 * guardrail: advisory-only, editable, and never auto-finalized.
 */
export function AISuggestion({ label, draft, onAccept, onReject, acceptLabel = 'Accept & Sign Off' }: AISuggestionProps) {
  const [text, setText] = useState(draft);
  const [rejected, setRejected] = useState(false);

  if (rejected) {
    return (
      <div className="ai-block">
        <div className="ai-head">
          <span className="ai-pill">AI SUGGESTED</span>
          <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>Suggestion discarded.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-block">
      <div className="ai-head">
        <span className="ai-pill">AI SUGGESTED</span>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      <div className="ai-actions">
        <button className="btn btn-primary btn-sm" onClick={() => onAccept(text)}>
          {acceptLabel}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setRejected(true);
            onReject?.();
          }}
        >
          Reject
        </button>
      </div>
      <p className="ai-note">Advisory only — review and edit before this becomes part of the medical record. Your decision is logged for audit.</p>
    </div>
  );
}
