import { useEffect } from 'react';
import { useHospitalStore } from './useHospitalStore';

const LOADERS = {
  patients: 'loadPatients',
  encounters: 'loadEncounters',
  staff: 'loadStaff',
  beds: 'loadBeds',
  drugs: 'loadDrugs',
  bills: 'loadBills',
  housekeepingLog: 'loadHousekeepingLog',
  pharmacyQueue: 'loadPharmacyQueue',
  dashboard: 'loadDashboard',
  opdBilling: 'loadOpdBilling',
  panels: 'loadPanels',
} as const;

export type Slice = keyof typeof LOADERS;

/**
 * Fetches the listed parts of the data when a screen opens, and again every `everySeconds` while it stays open (so a
 * doctor's queue shows patients checked in by the front desk). Does nothing without a backend: the demo data is
 * already in the store. A role that may not read a slice simply gets nothing back for it.
 */
export function useRefresh(slices: Slice[], everySeconds?: number) {
  useEffect(() => {
    const run = () => {
      const store = useHospitalStore.getState();
      for (const slice of slices) void store[LOADERS[slice]]();
    };
    run();
    if (!everySeconds) return;
    // Skip the refresh while the tab is hidden; do one as soon as it is shown again.
    const timer = setInterval(() => { if (!document.hidden) run(); }, everySeconds * 1000);
    const onVisible = () => { if (!document.hidden) run(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // The list of slices is fixed per screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
