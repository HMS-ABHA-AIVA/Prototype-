import type { WasteCategory } from '../types';

/** The CPCB Bio-Medical Waste Management Rules 2016 colour categories, as guidance shown on the waste screen. */
export interface WasteCategoryInfo {
  category: WasteCategory;
  label: string;
  examples: string;
  container: string;
  requiresOnsitePretreatment: boolean;
  pretreatmentMethod: string;
  disposalMethod: string;
}

/** Reference guide — CPCB Bio-Medical Waste Management Rules, 2016, Schedule I. */
export const wasteCategoryGuide: WasteCategoryInfo[] = [
  {
    category: 'yellow',
    label: 'Yellow',
    examples: 'Human anatomical waste, soiled/infectious waste, expired medicines, chemical waste, contaminated linen',
    container: 'Yellow non-chlorinated bag',
    requiresOnsitePretreatment: false,
    pretreatmentMethod: 'None required onsite',
    disposalMethod: 'Incineration / deep burial (off-site, at CBWTF)',
  },
  {
    category: 'red',
    label: 'Red',
    examples: 'Contaminated recyclable waste — tubing, IV sets, catheters, urine bags, gloves',
    container: 'Red bag',
    requiresOnsitePretreatment: true,
    pretreatmentMethod: 'Autoclave or chemical disinfection',
    disposalMethod: 'Autoclaved/disinfected then sent for recycling',
  },
  {
    category: 'white',
    label: 'White (translucent)',
    examples: 'Sharps — needles, syringes with fixed needles, scalpels, blades',
    container: 'White translucent puncture-proof container',
    requiresOnsitePretreatment: true,
    pretreatmentMethod: 'Autoclave / dry heat sterilization',
    disposalMethod: 'Shredded & encapsulated, then sent for final disposal',
  },
  {
    category: 'blue',
    label: 'Blue',
    examples: 'Glassware, metallic body implants',
    container: 'Blue puncture-proof container / cardboard box',
    requiresOnsitePretreatment: true,
    pretreatmentMethod: 'Disinfection',
    disposalMethod: 'Disinfected then sent for recycling',
  },
];
