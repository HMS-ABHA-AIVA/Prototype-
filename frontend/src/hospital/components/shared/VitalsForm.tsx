import { useState } from 'react';

export function VitalsForm({ onSubmit }: { onSubmit: (v: { temp: number; pulse: number; bp: string; spo2: number; rr: number }) => void }) {
  const [temp, setTemp] = useState('98.6');
  const [pulse, setPulse] = useState('80');
  const [bp, setBp] = useState('120/80');
  const [spo2, setSpo2] = useState('98');
  const [rr] = useState('18');

  return (
    <div>
      <div className="two-col">
        <div className="field"><label>Temp (°F)</label><input value={temp} onChange={(e) => setTemp(e.target.value)} /></div>
        <div className="field"><label>Pulse</label><input value={pulse} onChange={(e) => setPulse(e.target.value)} /></div>
        <div className="field"><label>BP</label><input value={bp} onChange={(e) => setBp(e.target.value)} /></div>
        <div className="field"><label>SpO2 (%)</label><input value={spo2} onChange={(e) => setSpo2(e.target.value)} /></div>
      </div>
      <button
        className="btn btn-sm"
        onClick={() => onSubmit({ temp: Number(temp), pulse: Number(pulse), bp, spo2: Number(spo2), rr: Number(rr) })}
      >
        + Record Vitals
      </button>
    </div>
  );
}
