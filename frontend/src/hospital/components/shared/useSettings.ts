import { useEffect, useState } from 'react';
import { apiEnabled } from '../../api/client';
import { fetchSettings, type HospitalSettings } from '../../api/masters';

/** The hospital's billing and print settings (GSTIN, consent wording, bill footer ...). Null until loaded, and in the stand-alone demo. */
export function useSettings(): HospitalSettings | null {
  const [settings, setSettings] = useState<HospitalSettings | null>(null);
  useEffect(() => {
    if (!apiEnabled) return;
    fetchSettings().then(setSettings).catch(() => setSettings(null)); // printouts fall back to plain headings
  }, []);
  return settings;
}
