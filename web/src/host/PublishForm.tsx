import { currencyDigits } from "../money.js";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError, type ActivityView } from "../api.js";
import { localWallToUtcInstant, isValidTimeZone } from "../schedule.js";
import { useSession } from "../session.js";

/**
 * Host publication form (issue #14). All input is retained on validation or
 * network failure; server field errors land next to their inputs; submission
 * is disabled while pending. A successful publication selects the new
 * activity — the actual response's activity id, never a guessed one.
 */

const CURRENCIES = ["NGN", "EUR", "USD", "GBP", "SEK", "JPY", "KWD"] as const;
const TIME_ZONES = [
  "Africa/Lagos",
  "Europe/Stockholm",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "UTC",
];

function defaultLocalWall(): string {
  const now = new Date(Date.now() + 48 * 3600 * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function PublishForm({ onPublished }: { onPublished: (activity: ActivityView) => void }): ReactNode {
  const { authorized } = useSession();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [itinerary, setItinerary] = useState("");
  const [wall, setWall] = useState(defaultLocalWall);
  const [timeZone, setTimeZone] = useState(browserZone);
  const [spots, setSpots] = useState("4");
  const [priceMinorUnits, setPriceMinorUnits] = useState("15.00");
  const [currency, setCurrency] = useState<(typeof CURRENCIES)[number]>("EUR");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setFieldErrors({});
    setFormError(null);

    const errors: Record<string, string> = {};
    let startsAt: string | null = null;
    if (!description.trim()) errors.description = "Describe the activity.";
    if (!itinerary.trim()) errors.itinerary = "Add the shared itinerary.";
    if (title.trim().length === 0) errors.title = "Give the plan a title.";
    if (!isValidTimeZone(timeZone)) errors.timezone = "Unknown timezone.";
    else {
      try {
        startsAt = localWallToUtcInstant(wall, timeZone).toISOString();
      } catch (err) {
        errors.startsAt = err instanceof Error ? err.message : "Check the date and time.";
      }
    }
    const spotsNumber = Number(spots);
    if (!Number.isInteger(spotsNumber) || spotsNumber < 1) errors.spots = "Spots must be a whole number of at least 1.";
    const digits = currencyDigits(currency);
    const amount = priceMinorUnits.trim() === "" ? NaN : Number(priceMinorUnits);
    const scaled = amount * 10 ** digits;
    const priceNumber = Math.round(scaled);
    if (!Number.isSafeInteger(priceNumber) || amount < 0 || Math.abs(scaled - priceNumber) > 0.000001) errors.priceMinorUnits = `Enter a nonnegative amount with at most ${digits} decimal places.`;
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setPending(true);
    try {
      const publication = await authorized((api, token) =>
        api.publishActivity(token, {
          title: title.trim(),
          description: description.trim(),
          itinerary: itinerary.trim(),
          startsAt: startsAt!,
          timezone: timeZone,
          priceMinorUnits: priceNumber,
          currency,
          spots: spotsNumber,
        }),
      );
      onPublished(publication.activity);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof ApiError) {
        if (err.fields !== undefined) setFieldErrors(err.fields);
        setFormError(err.message);
      } else {
        // Network failure: every entered value is retained for a retry.
        setFormError(err instanceof Error ? err.message : "Could not reach the API — your draft is kept.");
      }
    } finally {
      setPending(false);
    }
  };


  return (
    <section className="panel publish-panel" aria-labelledby="publish-heading">
      <h2 id="publish-heading">Publish an activity</h2>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label htmlFor="pub-title">Title</label>
        <input
          id="pub-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-invalid={fieldErrors.title !== undefined}
          aria-describedby={fieldErrors.title !== undefined ? "pub-title-error" : undefined}
        />
        {fieldErrors.title !== undefined && (
          <p className="field-error" id="pub-title-error" role="alert">{fieldErrors.title}</p>
        )}

        <label htmlFor="pub-description">Description</label>
        <textarea id="pub-description" value={description} onChange={event => setDescription(event.target.value)} aria-invalid={!!fieldErrors.description} aria-describedby="pub-description-error" />
        {fieldErrors.description && <p id="pub-description-error" className="field-error" role="alert">{fieldErrors.description}</p>}
        <label htmlFor="pub-itinerary">Itinerary</label>
        <textarea id="pub-itinerary" value={itinerary} onChange={event => setItinerary(event.target.value)} aria-invalid={!!fieldErrors.itinerary} aria-describedby="pub-itinerary-error" />
        {fieldErrors.itinerary && <p id="pub-itinerary-error" className="field-error" role="alert">{fieldErrors.itinerary}</p>}
        <div className="field-row">
          <div>
            <label htmlFor="pub-starts">Starts (selected timezone)</label>
            <input
              id="pub-starts"
              type="datetime-local"
              value={wall}
              onChange={(event) => setWall(event.target.value)}
              aria-invalid={fieldErrors.startsAt !== undefined}
              aria-describedby={fieldErrors.startsAt !== undefined ? "pub-starts-error" : undefined}
            />
          </div>
          <div>
            <label htmlFor="pub-timezone">Timezone</label>
            <select id="pub-timezone" value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
              {[...new Set([browserZone, ...TIME_ZONES])].map((zone) => (
                <option key={zone} value={zone}>{zone}</option>
              ))}
            </select>
            {fieldErrors.timezone && <p className="field-error" role="alert">{fieldErrors.timezone}</p>}
          </div>
        </div>
        {fieldErrors.startsAt !== undefined && (
          <p className="field-error" id="pub-starts-error" role="alert">{fieldErrors.startsAt}</p>
        )}


        <div className="field-row">
          <div>
            <label htmlFor="pub-spots">Spots</label>
            <input
              id="pub-spots"
              type="number"
              min={1}
              step={1}
              value={spots}
              onChange={(event) => setSpots(event.target.value)}
              aria-invalid={fieldErrors.spots !== undefined}
              aria-describedby={fieldErrors.spots !== undefined ? "pub-spots-error" : undefined}
            />
          </div>
          <div>
            <label htmlFor="pub-price">Price</label>
            <input
              id="pub-price"
              type="number"
              min={0}
              step="any"
              value={priceMinorUnits}
              onChange={(event) => setPriceMinorUnits(event.target.value)}
              aria-invalid={fieldErrors.priceMinorUnits !== undefined}
              aria-describedby={fieldErrors.priceMinorUnits !== undefined ? "pub-price-error" : undefined}
            />
          </div>
          <div>
            <label htmlFor="pub-currency">Currency</label>
            <select id="pub-currency" value={currency} onChange={(event) => setCurrency(event.target.value as typeof currency)}>
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </select>
            {fieldErrors.currency && <p className="field-error" role="alert">{fieldErrors.currency}</p>}
          </div>
        </div>
        {fieldErrors.spots !== undefined && (
          <p className="field-error" id="pub-spots-error" role="alert">{fieldErrors.spots}</p>
        )}
        {fieldErrors.priceMinorUnits !== undefined && (
          <p className="field-error" id="pub-price-error" role="alert">{fieldErrors.priceMinorUnits}</p>
        )}


        {formError !== null && (
          <div className="notice notice-warn" role="alert">
            {formError} Your entries are kept — adjust and submit again.
          </div>
        )}
        <button type="submit" className="button-primary" disabled={pending}>
          {pending ? "Publishing…" : "Publish activity"}
        </button>
      </form>
    </section>
  );
}
