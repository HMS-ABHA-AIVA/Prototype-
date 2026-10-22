import { useEffect, useState } from 'react';
import { apiEnabled } from '../../api/client';
import { fetchFacility, type FacilityProfile } from '../../api/facility';

/** The hospital's own profile (name, address, phone) for printed headings. Null until loaded, and in the stand-alone demo. */
export function useFacility(): FacilityProfile | null {
  const [facility, setFacility] = useState<FacilityProfile | null>(null);
  useEffect(() => {
    if (!apiEnabled) return;
    fetchFacility().then(setFacility).catch(() => setFacility(null)); // the heading falls back to a plain one
  }, []);
  return facility;
}
