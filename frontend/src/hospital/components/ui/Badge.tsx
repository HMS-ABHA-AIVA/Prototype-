type Tone = 'danger' | 'warn' | 'ok' | 'neutral' | 'info' | 'brand' | 'black';

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
