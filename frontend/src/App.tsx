import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { RequireSession } from "@/components/auth/RequireSession";
import { SignIn } from "@/pages/SignIn";
import { FacilitySetup } from "@/pages/FacilitySetup";
import { Dashboard } from "@/pages/Dashboard";
import { PatientList } from "@/pages/PatientList";
import { RegisterPatient } from "@/pages/RegisterPatient";
import { PatientRecord } from "@/pages/PatientRecord";
import { SharedProfiles } from "@/pages/SharedProfiles";
import { HospitalLayout } from "@/hospital/components/layout/HospitalLayout";

// The hospital modules' screens load on demand: a role downloads only the screens it opens.
const OpdQueue = lazy(() => import("@/hospital/modules/opd/OpdQueue").then((m) => ({ default: m.OpdQueue })));
const ConsultationView = lazy(() => import("@/hospital/modules/opd/ConsultationView").then((m) => ({ default: m.ConsultationView })));
const EmergencyPage = lazy(() => import("@/hospital/modules/emergency/EmergencyPage").then((m) => ({ default: m.EmergencyPage })));
const ErCaseView = lazy(() => import("@/hospital/modules/emergency/ErCaseView").then((m) => ({ default: m.ErCaseView })));
const BedBoard = lazy(() => import("@/hospital/modules/ipd/BedBoard").then((m) => ({ default: m.BedBoard })));
const IpdPatientView = lazy(() => import("@/hospital/modules/ipd/IpdPatientView").then((m) => ({ default: m.IpdPatientView })));
const MedicineRoundPage = lazy(() => import("@/hospital/modules/ipd/WardMedicine").then((m) => ({ default: m.MedicineRoundPage })));
const PharmacyPage = lazy(() => import("@/hospital/modules/pharmacy/PharmacyPage").then((m) => ({ default: m.PharmacyPage })));
const SuppliesPage = lazy(() => import("@/hospital/modules/supplies/SuppliesPage").then((m) => ({ default: m.SuppliesPage })));
const HousekeepingPage = lazy(() => import("@/hospital/modules/housekeeping/HousekeepingPage").then((m) => ({ default: m.HousekeepingPage })));
const WasteManagementPage = lazy(() => import("@/hospital/modules/housekeeping/WasteManagementPage").then((m) => ({ default: m.WasteManagementPage })));
const OpdBillingPage = lazy(() => import("@/hospital/modules/opdbilling/OpdBillingPage").then((m) => ({ default: m.OpdBillingPage })));
const PanelsPage = lazy(() => import("@/hospital/modules/panels/PanelsPage").then((m) => ({ default: m.PanelsPage })));
const BillingPage = lazy(() => import("@/hospital/modules/billing/BillingPage").then((m) => ({ default: m.BillingPage })));
const IpdBillView = lazy(() => import("@/hospital/modules/ipdbilling/IpdBillingPage").then((m) => ({ default: m.IpdBillView })));
const IpdBillingPage = lazy(() => import("@/hospital/modules/ipdbilling/IpdBillingPage").then((m) => ({ default: m.IpdBillingPage })));
const LabPage = lazy(() => import("@/hospital/modules/lab/LabPage").then((m) => ({ default: m.LabPage })));
const MastersPage = lazy(() => import("@/hospital/modules/masters/MastersPage").then((m) => ({ default: m.MastersPage })));
const PayrollPage = lazy(() => import("@/hospital/modules/payroll/PayrollPage").then((m) => ({ default: m.PayrollPage })));
const RosterPage = lazy(() => import("@/hospital/modules/roster/RosterPage").then((m) => ({ default: m.RosterPage })));
const PatientChart = lazy(() => import("@/hospital/modules/emr/PatientChart").then((m) => ({ default: m.PatientChart })));
const AuditPage = lazy(() => import("@/hospital/modules/audit/AuditPage").then((m) => ({ default: m.AuditPage })));
const StaffAccessPage = lazy(() => import("@/hospital/modules/access/StaffAccessPage").then((m) => ({ default: m.StaffAccessPage })));
const FacilityProfilePage = lazy(() => import("@/hospital/modules/facility/FacilityProfilePage").then((m) => ({ default: m.FacilityProfilePage })));
const PlatformPage = lazy(() => import("@/hospital/modules/platform/PlatformPage").then((m) => ({ default: m.PlatformPage })));

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<SignIn />} />

        {/* The platform console: the people who run the product set hospitals up here (its own sign-in, never a hospital's data) */}
        <Route path="/platform" element={<div className="os-page"><Suspense fallback={null}><PlatformPage /></Suspense></div>} />

        {/* The facility owner's login gets the facility setup page (ABDM credentials) */}
        <Route element={<RequireSession kind="facility" />}>
          <Route path="/facility-setup" element={<FacilitySetup />} />
        </Route>

        {/* Staff logins: the screens of their role */}
        <Route element={<RequireSession kind="staff" />}>
          <Route path="/" element={<Dashboard />} />

          {/* Registration, ABHA and Scan & Share (ABDM M1) */}
          <Route path="/registration" element={<PatientList />} />
          <Route path="/register" element={<RegisterPatient />} />
          <Route path="/shared-profiles" element={<SharedProfiles />} />
          <Route path="/record/:patientId" element={<PatientRecord />} />

          {/* The hospital modules */}
          <Route element={<HospitalLayout />}>
            <Route path="/emr/:patientId" element={<PatientChart />} />
            <Route path="/opd" element={<OpdQueue />} />
            <Route path="/opd/consult/:encounterId" element={<ConsultationView />} />
            <Route path="/opd-billing" element={<OpdBillingPage />} />
            <Route path="/emergency" element={<EmergencyPage />} />
            <Route path="/emergency/case/:encounterId" element={<ErCaseView />} />
            <Route path="/ipd" element={<BedBoard />} />
            <Route path="/ipd/patient/:encounterId" element={<IpdPatientView />} />
            <Route path="/medication-round" element={<MedicineRoundPage />} />
            <Route path="/lab" element={<LabPage />} />
            <Route path="/ipd-billing" element={<IpdBillingPage />} />
            <Route path="/ipd-billing/:encounterId" element={<IpdBillView />} />
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/panels" element={<PanelsPage />} />
            <Route path="/pharmacy" element={<PharmacyPage />} />
            <Route path="/supplies" element={<SuppliesPage />} />
            <Route path="/housekeeping" element={<HousekeepingPage />} />
            <Route path="/housekeeping/waste" element={<WasteManagementPage />} />
            <Route path="/roster" element={<RosterPage />} />
            <Route path="/payroll" element={<PayrollPage />} />
            <Route path="/masters" element={<MastersPage />} />
            <Route path="/facility" element={<FacilityProfilePage />} />
            <Route path="/access" element={<StaffAccessPage />} />
            <Route path="/audit" element={<AuditPage />} />
          </Route>

          {/* The bed board's address before the merge */}
          <Route path="/beds" element={<Navigate to="/ipd" replace />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
