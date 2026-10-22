const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function below100(n: number): string {
  if (n < 20) return ONES[n]!;
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
}

function below1000(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} hundred` : '', rest ? below100(rest) : ''].filter(Boolean).join(' ');
}

/** A whole number in the Indian way: crore, lakh, thousand. */
export function wordsIndian(n: number): string {
  if (n === 0) return 'zero';
  const parts: string[] = [];
  let rest = n;
  for (const [size, name] of [[10_000_000, 'crore'], [100_000, 'lakh'], [1000, 'thousand']] as [number, string][]) {
    const count = Math.floor(rest / size);
    if (count) parts.push(`${wordsIndian(count)} ${name}`);
    rest %= size;
  }
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}

/** "Rupees one thousand two hundred and fifty only" for printed receipts. */
export function rupeesInWords(amount: number): string {
  const paise = Math.round(Math.abs(amount) * 100);
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  const text = `Rupees ${wordsIndian(rupees)}${rest ? ` and ${below100(rest)} paise` : ''} only`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
