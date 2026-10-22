import { useEffect, useId, useState } from 'react';
import { apiEnabled } from '../../api/client';
import { fetchInvestigations, type Investigation } from '../../api/masters';

/**
 * A test-name box that suggests the tests on the hospital's own list (so the order is priced and reported against the right test). Anything
 * else can still be typed: it is then charged at the hospital's "test not on the list" price. Without the backend it is a plain box.
 */
export function OrderTestInput({
  kind,
  value,
  onChange,
  placeholder = 'Test name',
}: {
  kind: 'lab' | 'radiology';
  value: string;
  /** Called with the text and, when it is exactly a test on the list, that test's id. */
  onChange: (text: string, investigationId?: string) => void;
  placeholder?: string;
}) {
  const listId = useId();
  const [tests, setTests] = useState<Investigation[]>([]);

  useEffect(() => {
    if (!apiEnabled) return;
    let current = true;
    fetchInvestigations({ kind }).then((list) => { if (current) setTests(list); }, () => undefined);
    return () => { current = false; };
  }, [kind]);

  const match = (text: string) => tests.find((t) => t.name.toLowerCase() === text.trim().toLowerCase());

  return (
    <>
      <input
        list={listId}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value, match(e.target.value)?.id)}
      />
      <datalist id={listId}>
        {tests.map((t) => <option key={t.id} value={t.name}>{`₹${t.price}`}</option>)}
      </datalist>
    </>
  );
}
