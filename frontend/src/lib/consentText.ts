// Consent wording shown to the patient before any OTP is requested.
//
// ABHA creation (kind "create") follows the wording NHA publishes for ABHA creation by Aadhaar (consent code
// "abha-enrollment", version 1.4, the artifact the backend sends to ABDM). NHA's M1 reviewers expect it
// shown in full; confirm it against the current NHA M1 test sheet before submission and update here if it changed.
//
// Linking an existing ABHA (kind "link") uses the hospital's own wording (code "hospital-abha-link", version 1.0,
// stored with the transaction by the backend).
//
// Every text exists in English and Hindi. The Hindi text is a working translation: have it reviewed by a
// qualified translator (and, for the Aadhaar text, compared with NHA's published Hindi consent) before go-live.
// The language the patient saw is recorded with the transaction.

/** NDHM Health Data Management Policy (the link given in NDHM's secure-development reference, annexure). Confirm it is still current. */
export const PRIVACY_POLICY_URL = "https://ndhm.gov.in/documents/HealthDataManagementPolicy";

export type ConsentLanguage = "en" | "hi";
export type ConsentKind = "create" | "link";

export const CONSENT_LANGUAGES: { code: ConsentLanguage; label: string }[] = [
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी" },
];

export interface ConsentText {
  title: string;
  /** Matches the code/version the backend stores for this flow. */
  code: string;
  version: string;
  intro: string;
  points: string[];
  agreePrefix: string;
  privacyLinkText: string;
  languageLabel: string;
}

const EN_UI = {
  intro: "I hereby declare that:",
  agreePrefix: "The patient has read (or had read to them) and agrees to the consent above, and has been told about the",
  privacyLinkText: "Terms and Data Privacy Policy (ABDM Health Data Management Policy)",
  languageLabel: "Language",
};

const HI_UI = {
  intro: "मैं घोषणा करता/करती हूँ कि:",
  agreePrefix: "रोगी ने उपर्युक्त सहमति पढ़ ली है (या उन्हें पढ़कर सुनाई गई है) और वे इससे सहमत हैं, और उन्हें इसकी जानकारी दी गई है:",
  privacyLinkText: "नियम एवं डेटा गोपनीयता नीति (ABDM स्वास्थ्य डेटा प्रबंधन नीति)",
  languageLabel: "भाषा",
};

const CONSENTS: Record<ConsentKind, Record<ConsentLanguage, ConsentText>> = {
  create: {
    en: {
      ...EN_UI,
      title: "Consent for creating an ABHA number using Aadhaar",
      code: "abha-enrollment",
      version: "1.4",
      points: [
        "I am voluntarily sharing my Aadhaar number / Virtual ID and demographic information issued by UIDAI with the National Health Authority (NHA) for the sole purpose of creating an Ayushman Bharat Health Account number (ABHA number) and ABHA address.",
        "I understand that my ABHA number can be used and shared for purposes as may be notified by ABDM from time to time, including provision of healthcare services.",
        "I am aware that my personal identifiable information (name, address, age, date of birth, gender and photograph) may be made available to entities working in the National Digital Health Ecosystem (NDHE), such as healthcare professionals, facilities and health programmes registered with or linked to the Ayushman Bharat Digital Mission (ABDM).",
        "I authorise NHA to use my Aadhaar number for Aadhaar-based authentication with UIDAI, as per the Aadhaar Act, 2016, for the aforesaid purpose. I understand that UIDAI will share my e-KYC details, or a response of \"Yes\", with NHA upon successful authentication.",
        "I have been informed about the option of using other IDs apart from Aadhaar; however, I choose to use my Aadhaar number to avail the benefits across the NDHE.",
        "My personal identifiable information, excluding the Aadhaar number / VID number, can be used and shared for the purposes mentioned above.",
        "I reserve the right to revoke this consent at any time, as per the provisions of the Aadhaar Act and Regulations.",
      ],
    },
    hi: {
      ...HI_UI,
      title: "आधार का उपयोग करके ABHA संख्या बनाने के लिए सहमति",
      code: "abha-enrollment",
      version: "1.4",
      points: [
        "मैं स्वेच्छा से अपना आधार नंबर / वर्चुअल आईडी तथा UIDAI द्वारा जारी जनसांख्यिकीय जानकारी, आयुष्मान भारत स्वास्थ्य खाता संख्या (ABHA संख्या) और ABHA पता बनाने के एकमात्र उद्देश्य से, राष्ट्रीय स्वास्थ्य प्राधिकरण (NHA) के साथ साझा कर रहा/रही हूँ।",
        "मैं समझता/समझती हूँ कि मेरी ABHA संख्या का उपयोग और साझाकरण ABDM द्वारा समय-समय पर अधिसूचित उद्देश्यों के लिए किया जा सकता है, जिनमें स्वास्थ्य सेवाओं का प्रावधान भी शामिल है।",
        "मुझे ज्ञात है कि मेरी व्यक्तिगत पहचान योग्य जानकारी (नाम, पता, आयु, जन्म तिथि, लिंग और फोटो) राष्ट्रीय डिजिटल स्वास्थ्य पारिस्थितिकी तंत्र (NDHE) में कार्यरत संस्थाओं को उपलब्ध कराई जा सकती है, जैसे आयुष्मान भारत डिजिटल मिशन (ABDM) से पंजीकृत या जुड़े स्वास्थ्य पेशेवर, स्वास्थ्य सुविधाएँ और स्वास्थ्य कार्यक्रम।",
        "मैं आधार अधिनियम, 2016 के प्रावधानों के अनुसार, उपर्युक्त उद्देश्य के लिए UIDAI के साथ आधार-आधारित प्रमाणीकरण करने हेतु NHA को अपने आधार नंबर के उपयोग के लिए अधिकृत करता/करती हूँ। मैं समझता/समझती हूँ कि सफल प्रमाणीकरण पर UIDAI मेरी e-KYC जानकारी, या \"हाँ\" की प्रतिक्रिया, NHA को देगा।",
        "मुझे आधार के अलावा अन्य पहचान पत्रों के उपयोग के विकल्प की जानकारी दी गई है; फिर भी मैं NDHE में सेवाओं का लाभ लेने के लिए अपना आधार नंबर उपयोग करना चुनता/चुनती हूँ।",
        "आधार नंबर / वीआईडी को छोड़कर मेरी व्यक्तिगत पहचान योग्य जानकारी का उपयोग और साझाकरण ऊपर बताए उद्देश्यों के लिए किया जा सकता है।",
        "मैं आधार अधिनियम और विनियमों के प्रावधानों के अनुसार किसी भी समय इस सहमति को वापस लेने का अधिकार सुरक्षित रखता/रखती हूँ।",
      ],
    },
  },
  link: {
    en: {
      ...EN_UI,
      title: "Consent for linking an existing ABHA to this hospital record",
      code: "hospital-abha-link",
      version: "1.0",
      points: [
        "I am voluntarily asking this hospital to verify my existing ABHA with an OTP and to link it to my hospital record.",
        "I understand the hospital will retrieve my ABHA profile (name, date of birth, gender, ABHA number and ABHA address) from ABDM to confirm that it belongs to me, and will store my ABHA number and ABHA address against my record.",
        "I understand the hospital checks that the name and date of birth on my record match my ABHA, and will not link an ABHA that does not match.",
        "I can ask the hospital at any time to stop using my ABHA, and I may withdraw this consent.",
      ],
    },
    hi: {
      ...HI_UI,
      title: "मौजूदा ABHA को इस अस्पताल रिकॉर्ड से जोड़ने की सहमति",
      code: "hospital-abha-link",
      version: "1.0",
      points: [
        "मैं स्वेच्छा से इस अस्पताल से अनुरोध करता/करती हूँ कि वह OTP से मेरी मौजूदा ABHA का सत्यापन करे और उसे मेरे अस्पताल रिकॉर्ड से जोड़े।",
        "मैं समझता/समझती हूँ कि यह पुष्टि करने के लिए कि ABHA मेरी ही है, अस्पताल ABDM से मेरी ABHA प्रोफ़ाइल (नाम, जन्म तिथि, लिंग, ABHA संख्या और ABHA पता) प्राप्त करेगा, तथा मेरी ABHA संख्या और ABHA पता मेरे रिकॉर्ड के साथ संग्रहीत करेगा।",
        "मैं समझता/समझती हूँ कि अस्पताल जाँचता है कि मेरे रिकॉर्ड का नाम और जन्म तिथि मेरी ABHA से मेल खाते हैं, और जो ABHA मेल नहीं खाती उसे नहीं जोड़ेगा।",
        "मैं किसी भी समय अस्पताल से अपनी ABHA का उपयोग बंद करने के लिए कह सकता/सकती हूँ, और मैं अपनी सहमति वापस ले सकता/सकती हूँ।",
      ],
    },
  },
};

export const consentFor = (kind: ConsentKind, language: ConsentLanguage): ConsentText => CONSENTS[kind][language];
