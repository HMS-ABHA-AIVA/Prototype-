import { ApiError } from '../api/client';
import * as clinical from '../api/clinical';
import * as ops from '../api/operations';
import * as opdBilling from '../api/opdBilling';
import { fetchAudit } from '../api/audit';
import { reportError, useNoticeStore } from './useNoticeStore';
import type { Encounter } from '../types';
import type { HospitalState, ServerActions } from './useHospitalStore';

type SetState = (partial: Partial<HospitalState> | ((state: HospitalState) => Partial<HospitalState>)) => void;
type GetState = () => HospitalState;

/**
 * The store actions used when the app is connected to the backend. Each one asks the server to do the work, then
 * refreshes the part of the screen it changed from what the server saved, so the screen always shows stored data.
 */
export function createRemoteActions(set: SetState, get: GetState): ServerActions {
  /** Runs a server call; a refusal (e.g. "only 15 in stock") is shown to the person instead of throwing. */
  async function attempt(work: () => Promise<unknown>, afterFailure?: () => Promise<unknown>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (error) {
      reportError(error);
      await afterFailure?.().catch(() => undefined);
      return false;
    }
  }

  /** A loader: fills one slice. A 403 just means this role does not use that screen, so it stays quiet. */
  async function load(work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 403)) reportError(error);
      return false;
    }
  }

  /** Puts one freshly fetched visit into the screen's list, keeping any unsaved AI draft that lives only in the browser. */
  const mergeEncounter = (fresh: Encounter) =>
    set((s) => {
      const old = s.encounters.find((e) => e.id === fresh.id);
      const merged = { ...fresh, aiDischargeSummaryDraft: old?.aiDischargeSummaryDraft };
      return { encounters: old ? s.encounters.map((e) => (e.id === fresh.id ? merged : e)) : [merged, ...s.encounters] };
    });
  const refreshEncounter = async (id: string) => mergeEncounter(await clinical.fetchEncounter(id));

  const monthOf = (date: string) => date.slice(0, 7);
  const weekEnd = (start: string) => {
    const d = new Date(`${start}T00:00:00`);
    d.setDate(d.getDate() + 6);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  return {
    // ---- Loaders ----------------------------------------------------------------------------
    loadStaff: () => load(async () => set({ staff: await ops.fetchStaff() })).then(() => undefined),
    loadAudit: () => load(async () => set({ auditLog: await fetchAudit() })).then(() => undefined),

    loadAttendance: async (month) => {
      const ok = await load(async () => {
        const rows = await ops.fetchAttendance(month);
        set((s) => ({ attendance: [...s.attendance.filter((a) => !a.date.startsWith(month)), ...rows], attendanceAvailable: true }));
      });
      if (!ok) set({ attendanceAvailable: false });
    },
    loadPayrollRuns: () => load(async () => set({ payrollRuns: await ops.fetchPayrollRuns() })).then(() => undefined),

    loadRoster: (from, to) =>
      load(async () => {
        const rows = await ops.fetchRoster(from, to);
        set((s) => ({ roster: [...s.roster.filter((r) => r.date < from || r.date > to), ...rows] }));
      }).then(() => undefined),

    loadPatients: () => load(async () => set({ patients: await clinical.fetchPatients() })).then(() => undefined),
    loadEncounters: () =>
      load(async () => {
        const fresh = await clinical.fetchEncounters();
        set((s) => ({ encounters: fresh.map((e) => ({ ...e, aiDischargeSummaryDraft: s.encounters.find((o) => o.id === e.id)?.aiDischargeSummaryDraft })) }));
      }).then(() => undefined),
    loadBeds: () => load(async () => set({ beds: await ops.fetchBeds() })).then(() => undefined),
    loadHousekeepingLog: () => load(async () => set({ housekeepingLog: await ops.fetchHousekeepingLog() })).then(() => undefined),
    loadDrugs: () => load(async () => set({ drugs: await clinical.fetchDrugs() })).then(() => undefined),
    loadBills: () => load(async () => set({ bills: await clinical.fetchBills() })).then(() => undefined),
    loadPharmacyQueue: () => load(async () => set({ pharmacyQueue: await clinical.fetchPharmacyQueue() })).then(() => undefined),
    loadDashboard: () => load(async () => set({ dashboard: await clinical.fetchDashboard() })).then(() => undefined),
    loadOpdBilling: () => load(async () => set({ opdBilling: await opdBilling.fetchAwaitingOpd() })).then(() => undefined),
    // The invoices for the days and filters the OPD Billing screen is showing (today by default).
    loadOpdInvoices: (filter) => load(async () => set({ opdInvoices: await opdBilling.fetchInvoices(filter) })).then(() => undefined),
    // Administrators also see the panels that are switched off.
    loadPanels: () => load(async () => set({ panels: await opdBilling.fetchPanels(get().currentRole === 'admin') })).then(() => undefined),

    loadSupplies: () => load(async () => set({ supplies: await ops.fetchSupplies() })).then(() => undefined),
    loadSupplyLog: () => load(async () => set({ supplyLog: await ops.fetchSupplyLog() })).then(() => undefined),
    loadWaste: () => load(async () => set({ wasteBatches: await ops.fetchWaste() })).then(() => undefined),

    // ---- Staff ------------------------------------------------------------------------------
    addStaff: (data) => {
      void attempt(async () => {
        await ops.createStaff({
          name: data.name, role: data.role, department: data.department, employmentType: data.employmentType,
          monthlySalary: data.monthlySalary, feePerConsult: data.feePerConsult, bankAccountLast4: data.bankAccountLast4,
        });
        await get().loadStaff();
      });
    },

    updatePayInfo: (staffId, data) => {
      void attempt(async () => {
        await ops.updateStaff(staffId, {
          employmentType: data.employmentType,
          monthlySalary: data.monthlySalary ?? null,
          feePerConsult: data.feePerConsult ?? null,
          // only sent when the dialog had the field (doctors), so saving someone else's pay never clears a fee
          ...('consultationFee' in data ? { consultationFee: data.consultationFee ?? null } : {}),
          bankAccountLast4: data.bankAccountLast4 || null,
        });
        await get().loadStaff();
      });
    },

    // ---- Attendance and payroll -------------------------------------------------------------
    markAttendance: (staffId, date, shift, status) => {
      // Shown at once, then confirmed by the server; if the server refuses, the month is reloaded to the truth.
      set((s) => {
        const existing = s.attendance.find((a) => a.staffId === staffId && a.date === date && a.shift === shift);
        return {
          attendance: existing
            ? s.attendance.map((a) => (a === existing ? { ...a, status } : a))
            : [...s.attendance, { id: `pending-${staffId}-${date}-${shift}`, staffId, date, shift, status }],
        };
      });
      void attempt(() => ops.saveAttendance(staffId, date, shift, status), () => get().loadAttendance(monthOf(date)));
    },

    generatePayrollRun: async (month) => {
      let created: Awaited<ReturnType<typeof ops.generatePayroll>> | null = null;
      const ok = await attempt(async () => {
        created = await ops.generatePayroll(month);
        await get().loadPayrollRuns();
      });
      return ok ? created : null;
    },

    updatePayrollLineDeduction: (runId, staffId, deductions) =>
      attempt(async () => {
        await ops.saveDeduction(runId, staffId, deductions);
        await get().loadPayrollRuns();
      }, () => get().loadPayrollRuns()),

    finalizePayrollRun: (runId) => {
      void attempt(async () => {
        await ops.finalizePayroll(runId);
        await get().loadPayrollRuns();
      });
    },

    markPayrollPaid: (runId) => {
      void attempt(async () => {
        await ops.payPayroll(runId);
        await get().loadPayrollRuns();
      });
    },

    // ---- Roster -----------------------------------------------------------------------------
    toggleRosterAssignment: (staffId, date, shift, department) => {
      set((s) => {
        const existing = s.roster.find((r) => r.staffId === staffId && r.date === date && r.shift === shift);
        return {
          roster: existing
            ? s.roster.filter((r) => r !== existing)
            : [...s.roster, { id: `pending-${staffId}-${date}-${shift}`, staffId, date, shift, department }],
        };
      });
      const start = new Date(`${date}T00:00:00`);
      const monday = new Date(start);
      monday.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      const from = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
      void attempt(() => ops.toggleRoster(staffId, date, shift, department), () => get().loadRoster(from, weekEnd(from)));
    },

    copyWeek: async (fromStartDate, toStartDate) => {
      let copied = 0;
      await attempt(async () => {
        copied = (await ops.copyRosterWeek(fromStartDate, toStartDate)).copied;
        await get().loadRoster(toStartDate, weekEnd(toStartDate));
      });
      return copied;
    },

    // ---- Supplies ---------------------------------------------------------------------------
    addSupply: (data) => {
      void attempt(async () => {
        await ops.createSupply({ name: data.name, category: data.category, unit: data.unit, stock: data.stock, reorderLevel: data.reorderLevel, location: data.location });
        await get().loadSupplies();
      });
    },
    issueSupply: (supplyId, qty, department) => {
      void attempt(async () => {
        await ops.issueSupplyApi(supplyId, qty, department);
        await Promise.all([get().loadSupplies(), get().loadSupplyLog()]);
      }, () => get().loadSupplies());
    },
    restockSupply: (supplyId, qty) => {
      void attempt(async () => {
        await ops.restockSupplyApi(supplyId, qty);
        await Promise.all([get().loadSupplies(), get().loadSupplyLog()]);
      });
    },

    // ---- Bio-medical waste ------------------------------------------------------------------
    logSegregation: (category, department, weightKg) => {
      void attempt(async () => {
        await ops.segregateWaste(category, department, weightKg);
        await get().loadWaste();
      });
    },
    moveToStorage: (batchId, location) => {
      void attempt(async () => {
        await ops.storeWaste(batchId, location);
        await get().loadWaste();
      }, () => get().loadWaste());
    },
    pretreatBatch: (batchId, method) => {
      void attempt(async () => {
        await ops.pretreatWaste(batchId, method);
        await get().loadWaste();
      }, () => get().loadWaste());
    },
    disposeBatch: (batchId, vendor, manifestNo) => {
      void attempt(async () => {
        await ops.disposeWaste(batchId, vendor, manifestNo);
        await get().loadWaste();
      }, () => get().loadWaste());
    },

    // ---- Housekeeping -----------------------------------------------------------------------
    startCleaning: (bedId) => {
      void attempt(async () => {
        await ops.startCleaningApi(bedId);
        await Promise.all([get().loadBeds(), get().loadHousekeepingLog()]);
      }, () => get().loadBeds());
    },
    completeCleaning: (bedId) => {
      void attempt(async () => {
        await ops.completeCleaningApi(bedId);
        await Promise.all([get().loadBeds(), get().loadHousekeepingLog()]);
      }, () => get().loadBeds());
    },

    // ---- Patients and registration ----------------------------------------------------------
    registerPatient: async (data) => {
      let created: Awaited<ReturnType<typeof clinical.createPatient>> | null = null;
      await attempt(async () => {
        created = await clinical.createPatient({ name: data.name, age: data.age, gender: data.gender, phone: data.phone, allergies: data.allergies, problemList: data.problemList });
        set((s) => ({ patients: [created!, ...s.patients] }));
      });
      return created;
    },
    // The ABHA is attached to the patient by the server during the ABDM call; just refresh what the screen shows.
    applyAbha: () => {
      void get().loadPatients();
    },

    // ---- Visits: OPD ------------------------------------------------------------------------
    // Registering sends each consultation to OPD billing: it joins that doctor's queue only once its fee is collected.
    registerConsultations: async (patientId, consultations) => {
      let created: Encounter[] | null = null;
      await attempt(async () => {
        created = await opdBilling.registerConsultationsApi(patientId, consultations);
        created.forEach(mergeEncounter);
        await get().loadOpdBilling();
      });
      return created;
    },
    quoteOpd: async (input) => {
      let quote: opdBilling.Quote | null = null;
      // A quote that cannot be made (an impossible discount, say) just shows no total; the reason appears if the person goes on and tries to pay.
      try {
        quote = await opdBilling.quoteApi(input);
      } catch {
        quote = null;
      }
      return quote;
    },
    // Bills fees registered earlier: one payment, one invoice, a token and slip per doctor.
    collectOpdPayment: async (billIds, details, pricing) => {
      let invoice: opdBilling.OpdInvoice | null = null;
      await attempt(async () => {
        const done = await opdBilling.collectOpdPaymentApi(billIds, details, pricing);
        invoice = done.invoice;
        done.encounters.forEach(mergeEncounter);
        await Promise.all([get().loadOpdBilling(), get().loadOpdInvoices(), get().loadBills()]);
      }, () => get().loadOpdBilling());
      return invoice;
    },
    // OPD billing in one step: register for the doctors, price, take payment, issue tokens and slips.
    createOpdInvoice: async ({ patientId, consultations, details, pricing }) => {
      let invoice: opdBilling.OpdInvoice | null = null;
      await attempt(async () => {
        const done = await opdBilling.createInvoiceApi(patientId, consultations, details, pricing);
        invoice = done.invoice;
        done.encounters.forEach(mergeEncounter);
        await Promise.all([get().loadOpdBilling(), get().loadOpdInvoices(), get().loadBills()]);
      });
      return invoice;
    },
    cancelOpdInvoice: async (invoiceId, details) => {
      let invoice: opdBilling.OpdInvoice | null = null;
      await attempt(async () => {
        invoice = await opdBilling.cancelInvoiceApi(invoiceId, details);
        await Promise.all([get().loadOpdInvoices(), get().loadEncounters(), get().loadBills()]);
      });
      return invoice;
    },
    savePanel: async ({ id, ...input }) => {
      let saved: opdBilling.Panel | null = null;
      await attempt(async () => {
        saved = id ? await opdBilling.updatePanelApi(id, input) : await opdBilling.createPanelApi(input);
        await get().loadPanels();
      });
      return saved;
    },
    savePanelRates: (panelId, rates) =>
      attempt(async () => {
        await opdBilling.savePanelRatesApi(panelId, rates);
        await get().loadPanels();
      }),
    cancelOpdVisit: (billId) =>
      attempt(async () => {
        mergeEncounter(await opdBilling.cancelOpdVisitApi(billId));
        await Promise.all([get().loadOpdBilling(), get().loadBills()]);
      }, () => get().loadOpdBilling()),
    startConsult: (encounterId) => {
      void attempt(async () => {
        await clinical.startConsultApi(encounterId);
        await refreshEncounter(encounterId);
      }, () => refreshEncounter(encounterId));
    },
    saveSoapNote: (encounterId, soap) =>
      attempt(async () => {
        await clinical.saveSoapApi(encounterId, soap);
        await refreshEncounter(encounterId);
      }),
    addVitals: (encounterId, vitals) => {
      void attempt(async () => {
        await clinical.addVitalsApi(encounterId, vitals);
        await refreshEncounter(encounterId);
      });
    },
    addPrescription: (encounterId, rx) => {
      void attempt(async () => {
        await clinical.addPrescriptionApi(encounterId, rx);
        await refreshEncounter(encounterId);
      });
    },
    addOrder: (encounterId, order) => {
      void attempt(async () => {
        await clinical.addOrderApi(encounterId, order);
        await refreshEncounter(encounterId);
      });
    },
    // Closing a consultation also raises the bill on the server.
    closeConsult: (encounterId) =>
      attempt(async () => {
        await clinical.closeOpdApi(encounterId);
        await Promise.all([refreshEncounter(encounterId), get().loadBills()]);
      }, () => refreshEncounter(encounterId)),

    // ---- Visits: emergency ------------------------------------------------------------------
    checkInToEr: async (patientId, chiefComplaint, triageLevel, arrivalMode, doctorId) => {
      let created: Encounter | null = null;
      await attempt(async () => {
        created = await clinical.checkInEr(patientId, chiefComplaint, triageLevel, arrivalMode, doctorId);
        mergeEncounter(created);
      });
      return created;
    },
    updateTriage: (encounterId, triageLevel) => {
      void attempt(async () => {
        await clinical.setTriageApi(encounterId, triageLevel);
        await refreshEncounter(encounterId);
      });
    },
    resolveErEncounter: (encounterId, disposition, note, referredTo) =>
      attempt(async () => {
        await clinical.resolveErApi(encounterId, disposition, note, referredTo);
        await Promise.all([refreshEncounter(encounterId), get().loadBills()]);
      }, () => refreshEncounter(encounterId)),
    // The server links the ER visit to the new stay when it admits from it (see admitFromEncounter), so there is nothing to do here.
    linkAdmission: () => {},

    // ---- Visits: inpatient ------------------------------------------------------------------
    admitPatient: async (patientId, department, doctorId, bedId, billing) => {
      let created: Encounter | null = null;
      await attempt(async () => {
        created = await clinical.admitDirectApi(patientId, department, doctorId, bedId, billing);
        mergeEncounter(created);
        await get().loadBeds();
      }, () => get().loadBeds());
      return created;
    },
    admitFromEncounter: async (sourceEncounterId, department, doctorId, bedId, billing) => {
      let created: Encounter | null = null;
      await attempt(async () => {
        created = await clinical.admitFromApi(sourceEncounterId, department, doctorId, bedId, billing);
        mergeEncounter(created);
        await Promise.all([refreshEncounter(sourceEncounterId), get().loadBeds(), get().loadBills()]);
      }, () => get().loadBeds());
      return created;
    },
    transferBed: (encounterId, newBedId) => {
      void attempt(async () => {
        await clinical.transferBedApi(encounterId, newBedId);
        await Promise.all([refreshEncounter(encounterId), get().loadBeds(), get().loadHousekeepingLog()]);
      }, () => get().loadBeds());
    },
    // The draft comes from the server (an AI model when one is configured there, else a template) and stays in the browser
    // until the clinician signs it off.
    generateDischargeDraft: (encounterId) => {
      void attempt(async () => {
        const { draft, source } = await clinical.draftDischargeApi(encounterId);
        set((s) => ({ encounters: s.encounters.map((e) => (e.id === encounterId ? { ...e, aiDischargeSummaryDraft: draft } : e)) }));
        if (source === 'template') {
          useNoticeStore.getState().show('The AI assistant is not switched on for this hospital, so this draft was built from a template. Please review it carefully.', 'info');
        }
      });
    },
    acceptDischargeSummary: (encounterId, finalText) =>
      attempt(async () => {
        await clinical.dischargeApi(encounterId, finalText);
        await Promise.all([refreshEncounter(encounterId), get().loadBeds(), get().loadBills(), get().loadHousekeepingLog()]);
      }, () => refreshEncounter(encounterId)),

    // ---- Pharmacy and billing ---------------------------------------------------------------
    dispensePrescription: (encounterId, prescriptionId) => {
      void attempt(async () => {
        await clinical.dispenseApi(prescriptionId);
        await Promise.all([get().loadPharmacyQueue(), get().loadDrugs(), get().encounters.some((e) => e.id === encounterId) ? refreshEncounter(encounterId) : Promise.resolve()]);
      }, () => get().loadPharmacyQueue());
    },
    // Bills are raised by the server when a visit is closed, discharged or admitted onward; this just refreshes the list.
    generateBill: () => {
      void get().loadBills();
    },
    finalizeBill: (billId) => {
      void attempt(async () => {
        await clinical.finalizeBillApi(billId);
        await get().loadBills();
      }, () => get().loadBills());
    },
    markBillPaid: (billId) => {
      void attempt(async () => {
        await clinical.payBillApi(billId);
        await get().loadBills();
      }, () => get().loadBills());
    },
  };
}
