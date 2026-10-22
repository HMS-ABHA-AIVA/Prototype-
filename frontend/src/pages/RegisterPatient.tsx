import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { useAuthStore } from "@/store/useAuthStore";
import {
  createPatient,
  updatePatient,
  listPatients,
  requestAbhaCreateOtp,
  verifyAbhaCreateOtp,
  requestAbhaLinkOtp,
  confirmAbhaLink,
  requestAbhaMobileOtp,
  confirmAbhaMobileOtp,
  verifyAbhaMobileUser,
  requestAbhaNumberOtp,
  confirmAbhaNumberOtp,
  requestAbhaAddressOtp,
  confirmAbhaAddressOtp,
  type AbhaAccountItem,
  type BackendPatientWithAbha,
  type AbhaLoginChannel,
} from "@/api/endpoints";
import { CreateFollowUps } from "@/components/CreateFollowUps";
import { ConsentBox } from "@/components/ConsentBox";
import type { ConsentLanguage } from "@/lib/consentText";
import { formatOtpMessage } from "@/lib/otpMessage";
import { ContactUpdate } from "@/components/ContactUpdate";
import { withAbdmSession } from "@/api/abdmSession";
import { StopState } from "@/pages/ErrorStates";
import { ApiError } from "@/api/client";
import { photoSrc } from "@/components/AbhaProfileDetails";
import { mapApiError, type MappedErrorState } from "@/lib/errorHelper";
import { mobileProblem } from "@/lib/mobile";

import { OTP_RESEND_SECONDS, MAX_OTP_RESENDS } from "@/lib/abhaRules";
import { AtSign, Check, Fingerprint, Hash, IdCard, PlusCircle, Search, Smartphone, UserRoundPen } from "lucide-react";
import { PageHeader } from "@/components/ui/kit";

// 6 = optional follow-ups after creating an ABHA (verify mobile, choose ABHA address)
type Step = 1 | 2 | 3 | 4 | 5 | 6;
type AbhaMode = "create_aadhaar" | "link_aadhaar" | "link_mobile" | "link_number" | "link_address";

export function RegisterPatient() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const existingPatientId = searchParams.get("patientId");
  // Re-verifying an already linked patient: only link modes, and nothing new is created.
  const refresh = searchParams.get("refresh") === "1";

  const { environment } = useAuthStore();

  const [step, setStep] = useState<Step>(existingPatientId ? 2 : 1);
  const [mode, setMode] = useState<AbhaMode>(refresh ? "link_aadhaar" : "create_aadhaar");

  // Step 1: Patient details
  const [patientId, setPatientId] = useState<string>(existingPatientId || "");
  const [form, setForm] = useState({ name: "", abhaId: "", idSearch: "", dob: "", gender: "Male", mobile: "", email: "" });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Step 3: Identity & Consent
  const [aadhaar, setAadhaar] = useState("");
  const [linkMobileNumber, setLinkMobileNumber] = useState("");
  const [abhaNumber, setAbhaNumber] = useState("");
  const [abhaAddressInput, setAbhaAddressInput] = useState("");
  const [channel, setChannel] = useState<AbhaLoginChannel>("mobile");
  const [consent, setConsent] = useState(false);
  const [consentLanguage, setConsentLanguage] = useState<ConsentLanguage>("en");

  // Step 4: OTP verification
  const [transactionId, setTransactionId] = useState("");
  const [otp, setOtp] = useState("");
  // ABDM's own wording after an OTP is sent, e.g. "...mobile number ending with ******6375" (already masked)
  const [otpMessage, setOtpMessage] = useState("");
  // set after "create ABHA" succeeds; drives the optional follow-up step
  const [created, setCreated] = useState<{
    transactionId: string;
    mobileVerified: boolean;
    abhaNumber: string;
    abhaAddress: string | null;
  } | null>(null);
  // Step 1 route: look up an existing ABHA, create a new one, or register by hand
  const [route, setRoute] = useState<"existing" | "new" | "manual">("existing");
  // Existing-ABHA route: what the second box holds
  const [idKind, setIdKind] = useState<"mobile" | "aadhaar">("mobile");
  // Patients already registered on the mobile number that was searched
  const [phoneMatches, setPhoneMatches] = useState<{ phone: string; patients: BackendPatientWithAbha[] } | null>(null);
  // Last 4 digits of the Aadhaar-linked mobile, read from ABDM's "OTP sent to ******1234" message
  const [aadhaarMobileLast4, setAadhaarMobileLast4] = useState("");
  const [mobileAccounts, setMobileAccounts] = useState<AbhaAccountItem[]>([]);
  const [selectedAbhaNumber, setSelectedAbhaNumber] = useState("");

  // In-flight status and error handling
  const [loading, setLoading] = useState(false);
  const [errorState, setErrorState] = useState<MappedErrorState | null>(null);

  const [resendIn, setResendIn] = useState(0);
  // resends used for the current OTP request (NHA: at most 2, each after 60 s)
  const [resendCount, setResendCount] = useState(0);
  // the ABHA that was just created / linked, shown on the success screen
  const [linked, setLinked] = useState<{ abhaNumber: string; abhaAddress: string | null; mobileMatchesRecord?: boolean | undefined; detailsUpdated?: string[] | undefined } | null>(null);
  // Link flows: when the ABHA's mobile differs from the hospital record, offer (Yes/No) to update the ABHA
  const [contactPrompt, setContactPrompt] = useState<"ask" | "update" | "no">("ask");

  // Counts down the OTP resend cool-down.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  // "Add ABHA" on an existing patient skips step 1, so pick up the mobile number from their record.
  useEffect(() => {
    if (!existingPatientId) return;
    let cancelled = false;
    listPatients()
      .then((res) => {
        const p = (res.data || []).find((x) => x.id === existingPatientId);
        if (!cancelled && p) {
          setLinkMobileNumber((current) => current || p.phone);
          // verifying an ABHA that is already linked: start from the address on record
          if (p.abha?.abhaAddress) setAbhaAddressInput((current) => current || p.abha?.abhaAddress || "");
        }
      })
      .catch(() => {
        // the mobile number can still be typed in on the next step
      });
    return () => {
      cancelled = true;
    };
  }, [existingPatientId]);

  // After an ABHA was linked: an ABHA that already belongs to a patient here opens that record, otherwise on to the last step.
  function finishLink(d: {
    patientId?: string | undefined;
    abhaNumber: string;
    abhaAddress: string | null;
    mobileMatchesRecord?: boolean | undefined;
    detailsUpdated?: string[] | undefined;
    alreadyRegistered?: boolean | undefined;
  }) {
    if (d.patientId) setPatientId(d.patientId);
    if (d.alreadyRegistered && d.patientId) {
      navigate(`/record/${d.patientId}`, { state: { notice: "This ABHA is already registered here, so this is the existing patient record." } });
      return;
    }
    setLinked({ abhaNumber: d.abhaNumber, abhaAddress: d.abhaAddress, mobileMatchesRecord: d.mobileMatchesRecord, detailsUpdated: d.detailsUpdated });
    setStep(5);
  }

  // ABHA number or ABHA address, with a specific message when it is neither.
  function classifyAbhaId(raw: string): { kind: "link_number" | "link_address" } | { error: MappedErrorState } {
    const id = raw.trim();
    if (/^[\d\s-]+$/.test(id)) {
      const digits = id.replace(/\D/g, "").length;
      if (digits !== 14) {
        return { error: { tone: "error", title: "Invalid ABHA number", body: `The ABHA number has ${digits} digit${digits === 1 ? "" : "s"}, but it needs 14, for example 91-1234-5678-9012.` } };
      }
      return { kind: "link_number" };
    }
    if (id.includes("@") && !/@(sbx|abdm)$/i.test(id)) {
      return { error: { tone: "error", title: "Invalid ABHA address", body: "An ABHA address ends with @sbx (sandbox) or @abdm (production), for example name@sbx." } };
    }
    if (!/^[A-Za-z0-9._]{3,40}(@(sbx|abdm))?$/i.test(id)) {
      return { error: { tone: "error", title: "Invalid ABHA address", body: "An ABHA address has 3 to 40 letters, digits, dots or underscores, for example name@sbx." } };
    }
    return { kind: "link_address" };
  }

  // Second lookup box: the selector below it says whether the digits are a mobile or an Aadhaar number.
  function classifyMobileOrAadhaar(raw: string, kind: "mobile" | "aadhaar"): { kind: "link_mobile" | "link_aadhaar"; digits: string } | { error: MappedErrorState } {
    const label = kind === "mobile" ? "mobile" : "Aadhaar";
    const value = raw.trim();
    const stray = [...new Set(value.replace(/[\d\s]/g, ""))];
    if (stray.length > 0) {
      return { error: { tone: "error", title: `Invalid ${label} number`, body: `Digits only, but it has ${stray.map((c) => `"${c}"`).join(" ")}.` } };
    }
    const digits = value.replace(/\s/g, "");
    const n = digits.length;

    if (kind === "mobile") {
      const issue = mobileProblem(digits);
      return issue ? { error: { tone: "error", title: "Invalid mobile number", body: issue } } : { kind: "link_mobile", digits };
    }

    if (n !== 12) {
      return { error: { tone: "error", title: "Invalid Aadhaar number", body: `${n} digit${n === 1 ? "" : "s"} entered. An Aadhaar number has 12.` } };
    }
    if (/^[01]/.test(digits)) {
      return { error: { tone: "error", title: "Invalid Aadhaar number", body: `An Aadhaar number does not start with ${digits[0]}.` } };
    }
    return { kind: "link_aadhaar", digits };
  }

  // Step 1: validate the chosen route, make the patient record and go to the next screen.
  async function handleSavePatient(options: { skipPhoneMatches?: boolean } = {}) {
    setErrorState(null);
    setPhoneMatches(null);
    let linkMode: AbhaMode | null = null;
    let body: Parameters<typeof createPatient>[0] = {};
    let next: () => void = () => undefined;

    if (route === "existing") {
      const abhaId = form.abhaId.trim();
      const other = form.idSearch.trim();
      if (!abhaId && !other) {
        setErrorState({ tone: "error", title: "Nothing entered", body: "Fill in one of the two boxes." });
        return;
      }
      if (abhaId && other) {
        setErrorState({ tone: "error", title: "Two boxes filled", body: "Use one box: ABHA number / address, or mobile / Aadhaar." });
        return;
      }
      if (abhaId) {
        const found = classifyAbhaId(abhaId);
        if ("error" in found) return setErrorState(found.error);
        linkMode = found.kind;
        next = () => (found.kind === "link_number" ? setAbhaNumber(abhaId.replace(/[^\d-]/g, "").slice(0, 17)) : setAbhaAddressInput(abhaId));
      } else {
        const found = classifyMobileOrAadhaar(other, idKind);
        if ("error" in found) return setErrorState(found.error);
        linkMode = found.kind;
        if (found.kind === "link_mobile") body = { phone: found.digits };
        next = () => (found.kind === "link_mobile" ? setLinkMobileNumber(found.digits) : setAadhaar(found.digits));
      }
    } else if (route === "new") {
      const digits = aadhaar.replace(/\D/g, "");
      if (digits.length !== 12) {
        setErrorState({
          tone: "error",
          title: digits.length === 0 ? "Aadhaar number needed" : "Invalid Aadhaar number",
          body: digits.length === 0 ? "Enter the 12-digit Aadhaar number." : `The Aadhaar number has ${digits.length} digit${digits.length === 1 ? "" : "s"}, but it needs 12.`,
        });
        return;
      }
      const issue = mobileProblem(linkMobileNumber);
      if (issue) {
        setErrorState({ tone: "error", title: linkMobileNumber.trim() ? "Wrong mobile number" : "Mobile number needed", body: issue });
        return;
      }
      linkMode = "create_aadhaar";
      body = { phone: linkMobileNumber.trim() };
    } else {
      if (!form.name.trim()) {
        setErrorState({ tone: "error", title: "Name needed", body: "Enter the patient's full name." });
        return;
      }
      if (!form.dob) {
        setErrorState({ tone: "error", title: "Date of birth needed", body: "Required with a name." });
        return;
      }
      if (form.dob > new Date().toISOString().slice(0, 10)) {
        setErrorState({ tone: "error", title: "Invalid date of birth", body: "Date of birth cannot be in the future." });
        return;
      }
      const issue = mobileProblem(form.mobile);
      if (issue) {
        setErrorState({ tone: "error", title: form.mobile.trim() ? "Wrong mobile number" : "Mobile number needed", body: issue });
        return;
      }
      body = {
        name: form.name.trim(),
        phone: form.mobile.trim(),
        dateOfBirth: form.dob,
        gender: form.gender === "Male" ? "M" : form.gender === "Female" ? "F" : "O",
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
      };
    }

    // A mobile number is often shared by a family: show the patients already registered on it, so the right one can
    // be opened instead of registering again. "None of these" carries on to the ABHA search.
    if (route === "existing" && body.phone && !options.skipPhoneMatches) {
      setLoading(true);
      try {
        const phone = body.phone;
        const same = ((await listPatients()).data ?? []).filter((p) => p.phone === phone);
        if (same.length > 0) {
          setPhoneMatches({ phone, patients: same });
          setLoading(false);
          return;
        }
      } catch {
        // the list is only a shortcut: carry on with the ABHA search if it cannot be read
      }
      setLoading(false);
    }

    setLoading(true);
    try {
      // going Back from the OTP screens and continuing again reuses the record already made for this registration
      let id = route !== "manual" ? patientId : "";
      if (id) {
        if (body.phone) await updatePatient(id, { phone: body.phone });
      } else {
        id = (await createPatient(body)).data.id;
      }
      setPatientId(id);
      next();
      if (linkMode) {
        setMode(linkMode);
        setStep(3);
      } else {
        setStep(5);
      }
    } catch (err) {
      setErrorState(mapApiError(err));
    } finally {
      setLoading(false);
    }
  }

  // Step 3: Send OTP
  async function handleSendOtp() {
    setErrorState(null);
    if (!consent) {
      setErrorState({
        tone: "error",
        title: "Patient consent required",
        body: "Please confirm that the patient consents to using their credentials for ABHA.",
      });
      return;
    }

    if (mode === "create_aadhaar" || mode === "link_aadhaar") {
      const cleanAadhaar = aadhaar.replace(/\D/g, "");
      if (cleanAadhaar.length !== 12) {
        setErrorState({
          tone: "error",
          title: "Invalid Aadhaar number",
          body: "Aadhaar number must be exactly 12 digits.",
        });
        return;
      }
    }

    if (mode === "link_address") {
      const address = abhaAddressInput.trim();
      if (address.includes("@") && !/@(sbx|abdm)$/i.test(address)) {
        setErrorState({
          tone: "error",
          title: "That is an email address, not an ABHA address",
          body: "An ABHA address ends with @sbx (sandbox) or @abdm (production), for example name@sbx. The email saved on the ABHA cannot be used to find it.",
        });
        return;
      }
      if (!/^[A-Za-z0-9._]{3,40}(@(sbx|abdm))?$/i.test(address)) {
        setErrorState({
          tone: "error",
          title: "Invalid ABHA address",
          body: "Enter the ABHA address, for example name@sbx. The part after @ can be left out.",
        });
        return;
      }
    }

    if (mode === "link_number" && abhaNumber.replace(/\D/g, "").length !== 14) {
      setErrorState({
        tone: "error",
        title: "Invalid ABHA number",
        body: "ABHA number must be 14 digits, for example 91-1234-5678-9012.",
      });
      return;
    }

    // The mobile number is what ABHA is linked to (create) or searched by (link by mobile).
    if (mode === "create_aadhaar" || mode === "link_mobile") {
      const mobileIssue = mobileProblem(linkMobileNumber);
      if (mobileIssue) {
        setErrorState({ tone: "error", title: linkMobileNumber.trim() ? "Wrong mobile number" : "Mobile number needed", body: mobileIssue });
        return;
      }
    }

    setLoading(true);
    try {
      await requestOtp();
      setResendCount(0);
      setOtp("");
      setStep(4);
    } catch (err) {
      setErrorState(mapApiError(err, noAbhaAction(err)));
    } finally {
      setLoading(false);
    }
  }

  // NHA: when no ABHA exists for the number, the option to create one must stay open.
  function noAbhaAction(err: unknown) {
    if (err instanceof ApiError && err.code === "ABHA_NOT_FOUND" && !existingPatientId) {
      return {
        label: "Create a new ABHA",
        onClick: () => {
          setErrorState(null);
          setRoute("new");
          setStep(1);
        },
      };
    }
    return { label: "Try again", onClick: () => setErrorState(null) };
  }

  // Asks ABDM for an OTP for the current mode and remembers the transaction it belongs to.
  async function requestOtp() {
    await withAbdmSession(environment, async () => {
      const cleanAadhaar = aadhaar.replace(/\D/g, "");
      const cleanMobile = linkMobileNumber.replace(/\D/g, "");
      const res =
        mode === "create_aadhaar"
          ? await requestAbhaCreateOtp({ patientId, aadhaar: cleanAadhaar, environment, consent: true, consentLanguage })
          : mode === "link_aadhaar"
            ? await requestAbhaLinkOtp({ patientId, aadhaar: cleanAadhaar, environment, consent: true, consentLanguage })
            : mode === "link_address"
              ? await requestAbhaAddressOtp({ patientId, abhaAddress: abhaAddressInput.trim(), channel, environment, consent: true, consentLanguage })
              : mode === "link_number"
              ? await requestAbhaNumberOtp({ patientId, abhaNumber: abhaNumber.replace(/\D/g, ""), channel, environment, consent: true, consentLanguage })
              : await requestAbhaMobileOtp({ patientId, mobile: cleanMobile, environment, consent: true, consentLanguage });
      setTransactionId(res.data.transactionId);
      setOtpMessage(formatOtpMessage(mode, res.message ?? "", channel));
      // "...Mobile Number ******5006 linked with Aadhaar": the only part of that number ABDM tells us
      setAadhaarMobileLast4(/\*{3,}(\d{4})/.exec(res.message ?? "")?.[1] ?? "");
    });
    setResendIn(OTP_RESEND_SECONDS);
  }

  async function handleResendOtp() {
    if (resendCount >= MAX_OTP_RESENDS) return;
    setErrorState(null);
    setLoading(true);
    try {
      await requestOtp();
      setResendCount((n) => n + 1);
      setOtp("");
    } catch (err) {
      setErrorState(mapApiError(err));
    } finally {
      setLoading(false);
    }
  }

  // Step 4: Verify OTP
  async function handleVerifyOtp() {
    setErrorState(null);

    // If mobile accounts have already been loaded, proceed with user selection
    if (mode === "link_mobile" && mobileAccounts.length > 0) {
      if (!selectedAbhaNumber) {
        setErrorState({
          tone: "error",
          title: "Select an ABHA account",
          body: "Please choose which ABHA account to link to this patient.",
        });
        return;
      }
      setLoading(true);
      try {
        await withAbdmSession(environment, async () => {
          const res = await verifyAbhaMobileUser({
            abhaNumber: selectedAbhaNumber,
            transactionId,
            environment,
          });
          finishLink(res.data);
        });
        setStep(5);
      } catch (err) {
        setErrorState(mapApiError(err, noAbhaAction(err)));
      } finally {
        setLoading(false);
      }
      return;
    }

    const cleanOtp = otp.replace(/\D/g, "");
    if (cleanOtp.length !== 6) {
      setErrorState({
        tone: "error",
        title: "Invalid OTP",
        body: "OTP must be exactly 6 digits.",
      });
      return;
    }

    setLoading(true);
    try {
      await withAbdmSession(environment, async () => {
        if (mode === "create_aadhaar") {
          const mobileForEnrol = linkMobileNumber.replace(/\D/g, "");
          const res = await verifyAbhaCreateOtp({
            transactionId,
            otp: cleanOtp,
            mobile: mobileForEnrol,
            environment,
          });
          if (res.data.alreadyRegistered) {
            finishLink(res.data);
          } else if (res.data.hasFollowUp) {
            setPatientId(res.data.patientId);
            setCreated({
              transactionId: res.data.transactionId,
              // The mobile typed for the ABHA wins. Only when it is the Aadhaar-linked one (same last 4 digits as in
              // ABDM's OTP message) is it already verified; any other number gets its own OTP on the next screen.
              mobileVerified: res.data.mobileVerified && (!aadhaarMobileLast4 || mobileForEnrol.endsWith(aadhaarMobileLast4)),
              abhaNumber: res.data.abhaNumber,
              abhaAddress: res.data.abhaAddress,
            });
            setStep(6);
          } else {
            finishLink(res.data);
            setStep(5);
          }
        } else if (mode === "link_aadhaar") {
          const res = await confirmAbhaLink({
            transactionId,
            otp: cleanOtp,
            environment,
          });
          finishLink(res.data);
          setStep(5);
        } else if (mode === "link_address") {
          const res = await confirmAbhaAddressOtp({
            transactionId,
            otp: cleanOtp,
            channel,
            environment,
          });
          finishLink(res.data);
          setStep(5);
        } else if (mode === "link_number") {
          const res = await confirmAbhaNumberOtp({
            transactionId,
            otp: cleanOtp,
            channel,
            environment,
          });
          finishLink(res.data);
          setStep(5);
        } else if (mode === "link_mobile") {
            // Confirm OTP and retrieve linked accounts
            const res = await confirmAbhaMobileOtp({
              transactionId,
              otp: cleanOtp,
              environment,
            });
            const accounts = res.data?.accounts || [];
            if (accounts.length === 1) {
              // Only 1 account: link directly
              const linkedRes = await verifyAbhaMobileUser({
                abhaNumber: accounts[0].ABHANumber,
                transactionId: res.data.transactionId,
                environment,
              });
              finishLink(linkedRes.data);
              setStep(5);
            } else if (accounts.length > 1) {
              // Several ABHAs share this mobile number: the one whose name matches the patient is used.
              const matched = res.data.matchedAbhaNumbers ?? [];
              if (matched.length === 1) {
                const linkedRes = await verifyAbhaMobileUser({
                  abhaNumber: matched[0]!,
                  transactionId: res.data.transactionId,
                  environment,
                });
                finishLink(linkedRes.data);
                setStep(5);
                return;
              }
              // none (or several) matched: staff choose, from the matching ones when there are some
              const choices = matched.length > 1 ? accounts.filter((a) => matched.includes(a.ABHANumber)) : accounts;
              setMobileAccounts(choices);
              setSelectedAbhaNumber(choices[0]!.ABHANumber);
            } else {
              throw new Error("No ABHA accounts associated with this mobile number.");
            }
        }
      });
    } catch (err) {
      setErrorState(mapApiError(err, noAbhaAction(err)));
    } finally {
      setLoading(false);
    }
  }

  const inVerification = step === 2 || step === 3 || step === 4 || step === 6;
  const ROUTES = [
    { key: "existing", icon: Search, title: "Existing ABHA", text: "Search by ABHA number, ABHA address, mobile number or Aadhaar number" },
    { key: "new", icon: IdCard, title: "New ABHA", text: "Create using Aadhaar number and mobile number" },
    { key: "manual", icon: UserRoundPen, title: "Manual registration", text: "Name, date of birth, gender and mobile number" },
  ] as const;

  return (
    <AppShell active={existingPatientId ? "registration" : "register"} crumb={existingPatientId ? (refresh ? "Verify ABHA" : "Add ABHA") : undefined}>
      <PageHeader
        title={refresh ? "Verify ABHA" : existingPatientId ? "Add ABHA" : "New registration"}
        subtitle={refresh ? "Re-verify the linked ABHA to load live details" : existingPatientId ? "Link or create an ABHA for a registered patient" : "Register a patient by ABHA, Aadhaar or manual entry"}
        back={{
          label: existingPatientId ? "Patient record" : "Patient register",
          onClick: () => navigate(existingPatientId ? `/record/${existingPatientId}` : "/registration"),
        }}
      />
      <div className="reg-wrap">
        <ol className="steps" aria-label="Registration progress">
          <li className={step === 1 ? "current" : "done"} aria-current={step === 1 ? "step" : undefined}>
            <span className="num">{step === 1 ? 1 : <Check size={13} aria-hidden />}</span>
            <div className="step-text">
              <span className="lbl">{existingPatientId ? "Patient" : "Registration type"}</span>
              {step === 1 && <div className="state">In progress</div>}
            </div>
          </li>
          <li className={inVerification ? "current" : step === 5 ? "done" : ""} aria-current={inVerification ? "step" : undefined}>
            <span className="num">{step === 5 ? <Check size={13} aria-hidden /> : 2}</span>
            <div className="step-text">
              <span className="lbl">ABHA verification</span>
              {inVerification && <div className="state">In progress</div>}
            </div>
          </li>
          <li className={step === 5 ? "done" : ""} aria-current={step === 5 ? "step" : undefined}>
            <span className="num">{step === 5 ? <Check size={13} aria-hidden /> : 3}</span>
            <div className="step-text">
              <span className="lbl">Complete</span>
            </div>
          </li>
        </ol>

        {step === 1 && phoneMatches && (
          <div className="card-form">
            <h2>Patients on this mobile number</h2>
            <p className="lead">
              +91 {phoneMatches.phone} · {phoneMatches.patients.length} registered
            </p>
            <div className="choice-list">
              {phoneMatches.patients.map((p) => (
                <button key={p.id} type="button" className="choice" onClick={() => navigate(`/record/${p.id}`)}>
                  <span className="choice-icon">
                    <UserRoundPen size={17} aria-hidden />
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="choice-title" style={{ display: "block" }}>
                      {p.name}
                    </span>
                    <span className="choice-desc" style={{ display: "block" }}>
                      {[p.dateOfBirth ? `DOB ${p.dateOfBirth}` : null, p.abha ? "ABHA linked" : "No ABHA"].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="btn btn-sm btn-ghost" aria-hidden>
                    Open profile
                  </span>
                </button>
              ))}
            </div>
            <div className="form-actions">
              <button className="btn btn-ghost" type="button" onClick={() => setPhoneMatches(null)}>
                Back
              </button>
              <button className="btn btn-primary" type="button" onClick={() => void handleSavePatient({ skipPhoneMatches: true })} disabled={loading}>
                None of these, search ABHA
              </button>
            </div>
          </div>
        )}

        {step === 1 && !phoneMatches && (
          <div className="card-form">
            <h2>Registration type</h2>
            <p className="lead">Choose one</p>
            {errorState && (
              <div style={{ marginBottom: 14 }}>
                <StopState {...errorState} />
              </div>
            )}
            <div className="choice-list" role="radiogroup" aria-label="Registration type">
              {ROUTES.map(({ key, icon: Icon, title, text }) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={route === key}
                  className="choice"
                  onClick={() => {
                    setRoute(key);
                    setErrorState(null);
                  }}
                  disabled={loading}
                >
                  <span className="choice-icon">
                    <Icon size={17} aria-hidden />
                  </span>
                  <span>
                    <span className="choice-title" style={{ display: "block" }}>
                      {title}
                    </span>
                    <span className="choice-desc" style={{ display: "block" }}>
                      {text}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <hr className="sep" />

            {route === "existing" && (
              <>
                <div className="field">
                  <label>ABHA number / ABHA address</label>
                  <input
                    className="input mono"
                    autoComplete="off"
                    autoCapitalize="none"
                    placeholder="91-1234-5678-9012 or name@sbx"
                    value={form.abhaId}
                    onChange={(e) => set("abhaId", e.target.value.replace(/[^A-Za-z0-9._@\- ]/g, "").slice(0, 50))}
                    disabled={loading}
                  />
                </div>
                <div className="field">
                  <label htmlFor="id-search">{idKind === "mobile" ? "Mobile number" : "Aadhaar number"}</label>
                  <input
                    id="id-search"
                    className="input mono"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder={idKind === "mobile" ? "10 digits" : "12 digits"}
                    value={form.idSearch}
                    onChange={(e) => set("idSearch", e.target.value)}
                    disabled={loading}
                  />
                  <div className="seg" role="radiogroup" aria-label="Number type" style={{ marginTop: 8 }}>
                    {(
                      [
                        ["mobile", "Mobile number"],
                        ["aadhaar", "Aadhaar number"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        role="radio"
                        aria-checked={idKind === key}
                        className={idKind === key ? "on" : ""}
                        onClick={() => {
                          setIdKind(key);
                          setErrorState(null);
                        }}
                        disabled={loading}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {route === "new" && (
              <>
                <div className="field">
                  <label>Aadhaar number</label>
                  <input
                    className="input mono"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="12 digits"
                    value={aadhaar}
                    onChange={(e) => setAadhaar(e.target.value.replace(/\D/g, "").slice(0, 12))}
                    disabled={loading}
                    maxLength={12}
                  />
                </div>
                <div className="field">
                  <label>Mobile number</label>
                  <div className="mobile-wrap">
                    <span className="mobile-prefix">+91</span>
                    <input
                      className="input mono"
                      inputMode="numeric"
                      placeholder="10 digits"
                      value={linkMobileNumber}
                      onChange={(e) => setLinkMobileNumber(e.target.value)}
                      disabled={loading}
                    />
                  </div>
                </div>
              </>
            )}

            {route === "manual" && (
              <>
                <div className="field">
                  <label>Full name</label>
                  <input
                    className="input"
                    value={form.name}
                    onChange={(e) => set("name", e.target.value)}
                    disabled={loading}
                  />
                </div>
                <div className="row">
                  <div className="field" style={{ width: 170 }}>
                    <label>Date of birth</label>
                    <input
                      className="input"
                      type="date"
                      max={new Date().toISOString().slice(0, 10)}
                      value={form.dob}
                      onChange={(e) => set("dob", e.target.value)}
                      disabled={loading}
                    />
                  </div>
                  <div className="field">
                    <label>Gender</label>
                    <div className="seg">
                      {["Male", "Female", "Other"].map((g) => (
                        <button
                          key={g}
                          type="button"
                          className={form.gender === g ? "on" : ""}
                          onClick={() => set("gender", g)}
                          disabled={loading}
                        >
                          {g}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="field">
                  <label>Mobile number</label>
                  <div className="mobile-wrap">
                    <span className="mobile-prefix">+91</span>
                    <input
                      className="input"
                      placeholder="10 digits"
                      value={form.mobile}
                      onChange={(e) => set("mobile", e.target.value)}
                      disabled={loading}
                    />
                  </div>
                </div>
                <div className="field">
                  <label>
                    Email <span className="opt">(optional)</span>
                  </label>
                  <input className="input" value={form.email} onChange={(e) => set("email", e.target.value)} disabled={loading} />
                </div>
              </>
            )}

            <div className="form-actions">
              <button className="btn-link" type="button" onClick={() => navigate("/")} disabled={loading}>
                Cancel
              </button>
              <button className="btn btn-primary" type="button" onClick={() => void handleSavePatient()} disabled={loading}>
                {loading ? "Please wait..." : route === "manual" ? "Register" : route === "new" ? "Continue" : "Search"}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="card-form">
            <h2>{refresh ? "Verify ABHA" : "Add ABHA"}</h2>
            <p className="lead">{refresh ? "Loads live ABHA details and QR code" : "Choose a method"}</p>
            {errorState && (
              <div style={{ marginBottom: 14 }}>
                <StopState {...errorState} />
              </div>
            )}
            <div className="choice-list">
              {(
                [
                  ...(refresh ? [] : [{ mode: "create_aadhaar", icon: PlusCircle, title: "Create by Aadhaar", text: "New ABHA · Aadhaar OTP" }]),
                  { mode: "link_aadhaar", icon: Fingerprint, title: "Link by Aadhaar", text: "Existing ABHA · Aadhaar OTP" },
                  { mode: "link_mobile", icon: Smartphone, title: "Link by mobile number", text: "Existing ABHA · OTP to the ABHA-registered mobile" },
                  { mode: "link_number", icon: Hash, title: "Link by ABHA number", text: "14-digit ABHA number · OTP to the communication or Aadhaar-registered mobile" },
                  { mode: "link_address", icon: AtSign, title: "Link by ABHA address", text: "name@sbx · OTP to the communication or Aadhaar-registered mobile" },
                ] as { mode: AbhaMode; icon: typeof Hash; title: string; text: string }[]
              ).map(({ mode: m, icon: Icon, title, text }) => (
                <button
                  key={m}
                  type="button"
                  className="choice"
                  onClick={() => {
                    setMode(m);
                    setErrorState(null);
                    setStep(3);
                  }}
                >
                  <span className="choice-icon">
                    <Icon size={17} aria-hidden />
                  </span>
                  <span>
                    <span className="choice-title" style={{ display: "block" }}>
                      {title}
                    </span>
                    <span className="choice-desc" style={{ display: "block" }}>
                      {text}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <div className="form-actions">
              {refresh ? (
                <button className="btn btn-ghost" type="button" onClick={() => navigate(`/record/${patientId}`)}>
                  Back to patient record
                </button>
              ) : (
                <button className="btn btn-ghost" type="button" onClick={() => setStep(5)}>
                  Skip for now
                </button>
              )}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="card-form">
            <h2>
              {mode === "link_mobile"
                ? "Mobile number"
                : mode === "link_address"
                  ? "ABHA address"
                : mode === "link_number"
                  ? "ABHA number"
                  : mode === "create_aadhaar"
                    ? "Aadhaar and mobile number"
                    : "Aadhaar number"}
            </h2>
            <p className="lead">
              {mode === "link_mobile"
                ? "OTP to the mobile registered with ABHA"
                : mode === "link_number" || mode === "link_address"
                  ? "OTP to the selected mobile"
                  : "OTP to the Aadhaar-linked mobile"}
            </p>
            {errorState && (
              <div style={{ marginBottom: 14 }}>
                <StopState {...errorState} />
              </div>
            )}
            {(mode === "link_number" || mode === "link_address") && (
              <>
                {mode === "link_number" ? (
                  <div className="field">
                    <label>ABHA number</label>
                    <input
                      className="input mono"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="91-1234-5678-9012"
                      value={abhaNumber}
                      onChange={(e) => setAbhaNumber(e.target.value.replace(/[^\d-]/g, "").slice(0, 17))}
                      disabled={loading}
                    />
                  </div>
                ) : (
                  <div className="field">
                    <label>ABHA address</label>
                    <input
                      className="input mono"
                      autoComplete="off"
                      autoCapitalize="none"
                      placeholder="name@sbx"
                      value={abhaAddressInput}
                      onChange={(e) => setAbhaAddressInput(e.target.value.replace(/[^A-Za-z0-9._@]/g, "").slice(0, 50))}
                      disabled={loading}
                    />
                    <div className="hint">
                      This is the ABHA address (for example name@sbx), not the email. The part after @ can be left out; it is added for the
                      sandbox or production automatically.
                    </div>
                  </div>
                )}
                <div className="field">
                  <label>Send the OTP to</label>
                  <div className="seg">
                    <button type="button" className={channel === "mobile" ? "on" : ""} onClick={() => setChannel("mobile")} disabled={loading}>
                      Communication mobile (ABHA)
                    </button>
                    <button type="button" className={channel === "aadhaar" ? "on" : ""} onClick={() => setChannel("aadhaar")} disabled={loading}>
                      Aadhaar-registered mobile
                    </button>
                  </div>
                  <div className="hint">
                    {channel === "mobile"
                      ? "The OTP goes to the mobile number on the ABHA profile. If the patient's number is different from the one registered with Aadhaar, or the ABHA has none, choose the Aadhaar-registered mobile."
                      : "The OTP is sent by UIDAI to the mobile number registered with the patient's Aadhaar."}
                  </div>
                </div>
              </>
            )}
            {(mode === "create_aadhaar" || mode === "link_aadhaar") && (
              <div className="field">
                <label>Aadhaar number</label>
                <input
                  className="input mono"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="12 digits"
                  value={aadhaar}
                  onChange={(e) => setAadhaar(e.target.value.replace(/\D/g, "").slice(0, 12))}
                  disabled={loading}
                  maxLength={12}
                />
                <div className="hint">Hidden as you type. It is sent to ABDM encrypted and is not stored here.</div>
              </div>
            )}
            {(mode === "create_aadhaar" || mode === "link_mobile") && (
              <div className="field">
                <label>{mode === "create_aadhaar" ? "Mobile number to link with the new ABHA" : "Mobile number"}</label>
                <div className="mobile-wrap">
                  <span className="mobile-prefix">+91</span>
                  <input
                    className="input mono"
                    inputMode="numeric"
                    placeholder="10 digits"
                    value={linkMobileNumber}
                    onChange={(e) => setLinkMobileNumber(e.target.value.replace(/\D/g, "").slice(0, 10))}
                    disabled={loading}
                  />
                </div>
              </div>
            )}
            <ConsentBox
              kind={mode === "create_aadhaar" ? "create" : "link"}
              language={consentLanguage}
              onLanguageChange={setConsentLanguage}
              checked={consent}
              onChange={setConsent}
              disabled={loading}
            />
            <div className="form-actions">
              <button className="btn-link" type="button" onClick={() => { setErrorState(null); setStep(existingPatientId ? 2 : 1); }} disabled={loading}>
                Back
              </button>
              <button className="btn btn-primary" type="button" onClick={handleSendOtp} disabled={loading}>
                {loading ? "Sending OTP..." : "Send OTP"}
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="card-form">
            <h2>{mobileAccounts.length > 0 ? "Select ABHA account" : "Enter OTP"}</h2>
            <p className="lead">
              {mobileAccounts.length > 0
                ? `${mobileAccounts.length} ABHA accounts on this mobile number`
                : `${mode === "link_mobile" ? "ABHA exists on this communication mobile. " : ""}${otpMessage || "6-digit OTP sent"} · valid 10 minutes`}
            </p>
            {errorState && (
              <div style={{ marginBottom: 14 }}>
                <StopState {...errorState} />
              </div>
            )}

            {mobileAccounts.length > 0 ? (
              <div className="choice-list" role="radiogroup" aria-label="ABHA accounts">
                {mobileAccounts.map((acc) => (
                  <button
                    key={acc.ABHANumber}
                    type="button"
                    role="radio"
                    aria-checked={selectedAbhaNumber === acc.ABHANumber}
                    className="choice"
                    onClick={() => setSelectedAbhaNumber(acc.ABHANumber)}
                    disabled={loading}
                  >
                    <span className="choice-icon" style={photoSrc(acc.profilePhoto) ? { padding: 0, overflow: "hidden" } : undefined}>
                      {photoSrc(acc.profilePhoto) ? (
                        <img src={photoSrc(acc.profilePhoto)} alt="" width={36} height={36} style={{ objectFit: "cover" }} />
                      ) : (
                        <IdCard size={17} aria-hidden />
                      )}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span className="choice-title mono" style={{ display: "block" }}>
                        {acc.ABHANumber}
                      </span>
                      <span className="choice-desc" style={{ display: "block" }}>
                        {[acc.name, acc.preferredAbhaAddress].filter(Boolean).join(" · ") || "No name returned by ABDM"}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="field" style={{ maxWidth: 240 }}>
                <label htmlFor="otp">OTP</label>
                <input
                  id="otp"
                  className="input otp-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => e.key === "Enter" && !loading && void handleVerifyOtp()}
                  disabled={loading}
                  autoFocus
                />
              </div>
            )}

            <div className="form-actions">
              <button
                className="btn btn-quiet"
                type="button"
                onClick={() => {
                  setErrorState(null);
                  setOtp("");
                  setMobileAccounts([]);
                  setStep(3);
                }}
                disabled={loading}
              >
                Start again
              </button>
              <div className="inline">
                {mobileAccounts.length === 0 && (
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={handleResendOtp}
                    disabled={loading || resendIn > 0 || resendCount >= MAX_OTP_RESENDS}
                  >
                    {resendCount >= MAX_OTP_RESENDS
                      ? "Resend limit reached"
                      : resendIn > 0
                        ? `Resend in ${resendIn}s`
                        : `Resend OTP (${MAX_OTP_RESENDS - resendCount} left)`}
                  </button>
                )}
                <button className="btn btn-primary" type="button" onClick={handleVerifyOtp} disabled={loading}>
                  {loading && <span className="spinner" aria-hidden />}
                  {loading ? "Verifying" : mobileAccounts.length > 0 ? "Link selected ABHA" : "Verify OTP"}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 6 && created && (
          <CreateFollowUps
            transactionId={created.transactionId}
            mobile={linkMobileNumber.replace(/\D/g, "")}
            mobileVerified={created.mobileVerified}
            abhaNumber={created.abhaNumber}
            abhaAddress={created.abhaAddress}
            environment={environment}
            onDone={(finalAddress) => {
              setLinked({ abhaNumber: created.abhaNumber, abhaAddress: finalAddress });
              setStep(5);
            }}
          />
        )}

        {step === 5 && (
          <div className="card-form">
            <h2>Done</h2>
            <p className="lead">
              <span className="dot ok" />
              {refresh
                ? "ABHA verified. Live details and the QR code are now available on the record."
                : linked
                  ? "ABHA linked"
                  : "Patient registered"}
            </p>
            {linked && (
              <div className="kv" style={{ marginBottom: 14 }}>
                <div className="k">ABHA number</div>
                <div className="mono">{linked.abhaNumber}</div>
                <div className="k">ABHA address</div>
                <div className="mono">{linked.abhaAddress ?? "—"}</div>
              </div>
            )}
            {linked?.detailsUpdated && linked.detailsUpdated.length > 0 && (
              <div className="notice" style={{ marginBottom: 14 }}>
                The patient's {linked.detailsUpdated.join(" and ")} did not match the ABHA, so {linked.detailsUpdated.length > 1 ? "they have" : "it has"} been
                updated from the ABHA. This is noted on the patient's record.
              </div>
            )}
            {linked?.mobileMatchesRecord === false && contactPrompt !== "no" && (
              <div style={{ marginBottom: 14 }}>
                {contactPrompt === "ask" ? (
                  <div className="notice">
                    <div style={{ marginBottom: 8 }}>
                      The mobile number held on this ABHA is different from the number on the hospital record (+91{" "}
                      {linkMobileNumber.replace(/\D/g, "")}). Update the ABHA to use the hospital's number?
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <button className="btn btn-primary" type="button" onClick={() => setContactPrompt("update")}>
                        Yes, update the ABHA
                      </button>
                      <button className="btn btn-ghost" type="button" onClick={() => setContactPrompt("no")}>
                        No, keep it as it is
                      </button>
                    </div>
                  </div>
                ) : (
                  <ContactUpdate
                    patientId={patientId}
                    type="mobile"
                    environment={environment}
                    initialValue={linkMobileNumber.replace(/\D/g, "")}
                    intro="An OTP is sent to the new number. This changes the mobile on the patient's ABHA at ABDM."
                    onDone={() => undefined}
                    onCancel={() => setContactPrompt("no")}
                  />
                )}
              </div>
            )}
            <div className="form-actions end">
              {!existingPatientId && (
                <button className="btn btn-ghost" onClick={() => window.location.assign("/register")}>
                  Register another patient
                </button>
              )}
              <button className="btn btn-primary" onClick={() => navigate(`/record/${patientId}`)}>
                Open patient record
              </button>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
