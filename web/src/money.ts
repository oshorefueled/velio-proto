export function currencyDigits(currency: string): number {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function formatMoney(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minorUnits / 10 ** currencyDigits(currency));
}

/** The mockup card style: "NGN 12,500" when minor units are zero, "€12.50" when not. */
export function formatMoneyCompact(minorUnits: number, currency: string): string {
  const digits = currencyDigits(currency);
  const wholeMinor = minorUnits % 10 ** digits === 0;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: wholeMinor ? 0 : digits,
    maximumFractionDigits: digits,
  }).format(minorUnits / 10 ** digits);
}
