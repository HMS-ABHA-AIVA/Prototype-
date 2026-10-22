import { useEffect, useId, useRef, useState } from 'react';
import { apiEnabled } from '../../api/client';
import { checkDrug, searchDrugs, type DrugCheck, type DrugSuggestion } from '../../api/drugs';
import { Badge } from '../ui/Badge';

const KIND_LABEL: Record<DrugSuggestion['kind'], string> = {
  formulary: 'Your pharmacy',
  generic: 'Generic',
  brand: 'Brand',
  international: 'International',
};

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** When given, the chosen medicine is also checked against this visit's patient (allergies, already prescribed). */
  encounterId?: string;
  disabled?: boolean;
}

/**
 * The drug-name box with suggestions as you type: this hospital's pharmacy first, then generic names, then Indian brands
 * (with what they are made of). Choosing one fills the box; it never forces a choice, so any name can still be typed.
 * After a name is chosen or typed, a warning appears under the box if it clashes with the patient's allergies, is already
 * prescribed, or is not found in any drug list. Without the backend it is a plain text box.
 */
export function DrugNameInput({ value, onChange, placeholder, encounterId, disabled }: Props) {
  const listId = useId();
  const [items, setItems] = useState<DrugSuggestion[]>([]);
  const [didYouMean, setDidYouMean] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [check, setCheck] = useState<{ name: string; result: DrugCheck } | null>(null);
  const latest = useRef(0);
  // Set when the text changes because a suggestion was chosen, so choosing does not immediately search again.
  const justChose = useRef(false);

  useEffect(() => {
    if (!apiEnabled || disabled) return;
    if (justChose.current) {
      justChose.current = false;
      return;
    }
    const text = value.trim();
    if (text.length < 2) {
      setItems([]);
      setDidYouMean(null);
      return;
    }
    const ticket = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const found = await searchDrugs(text);
        if (ticket !== latest.current) return; // an older answer arriving late
        setItems(found.results);
        setDidYouMean(found.didYouMean);
        setActive(-1);
      } catch {
        if (ticket === latest.current) setItems([]); // suggestions are a help, never a blocker
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [value, disabled]);

  // The warning belongs to the name it was checked for: once the text changes it is no longer shown.
  const shownCheck = check && check.name === value.trim() ? check.result : null;

  async function runCheck(name: string) {
    const text = name.trim();
    if (!apiEnabled || text.length < 3) return;
    try {
      setCheck({ name: text, result: await checkDrug(text, encounterId) });
    } catch {
      setCheck(null);
    }
  }

  function choose(item: DrugSuggestion) {
    justChose.current = true;
    onChange(item.name);
    setOpen(false);
    setItems([]);
    setDidYouMean(null);
    void runCheck(item.name);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || items.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      choose(items[active]!);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  const showList = open && apiEnabled && !disabled && (items.length > 0 || didYouMean);

  return (
    <div className="drug-input">
      <input
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          void runCheck(value);
        }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={Boolean(showList)}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
      />
      {showList && (
        // onMouseDown (not onClick): the box would lose focus, close the list and swallow the click first.
        <ul className="drug-list" id={listId} role="listbox">
          {didYouMean && (
            <li className="drug-hint" onMouseDown={(e) => { e.preventDefault(); onChange(didYouMean); }}>
              Showing results for <b>{didYouMean}</b>
            </li>
          )}
          {items.map((item, i) => (
            <li
              key={`${item.kind}-${item.name}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => { e.preventDefault(); choose(item); }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="drug-name">{item.name}</span>
              <span className={`drug-kind ${item.kind}`}>{KIND_LABEL[item.kind]}</span>
              {item.detail && <span className="drug-detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {shownCheck && (
        <div className="drug-flags">
          {shownCheck.allergyWarning && <Badge tone="danger">⚠ {shownCheck.allergyWarning}</Badge>}
          {shownCheck.alreadyPrescribed && <Badge tone="warn">Already on this prescription</Badge>}
          {shownCheck.recognised === false && <Badge tone="warn">Not found in the drug lists. Check the spelling</Badge>}
          {shownCheck.generic && <span className="drug-generic">Contains {shownCheck.generic}</span>}
        </div>
      )}
    </div>
  );
}
