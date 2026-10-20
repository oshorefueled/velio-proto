import { currencyDigits } from "../money.js";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError, type ActivityView } from "../api.js";
import { localWallToUtcInstant, isValidTimeZone } from "../schedule.js";
import { useSession } from "../session.js";
import { InfoIcon } from "../icons.js";

/**
 * Host publication form (issue #14), revamped to the two numbered sections
 * of the mockup. All input is retained on validation or network failure;
 * server field errors land next to their inputs; submission is disabled
 * while pending. The 500-character counters are a client-side guideline the
 * mockup prescribes. A successful publication selects the new activity —
 * the actual response's activity id, never a guessed one.
 */

const CURRENCIES = ["NGN", "EUR", "USD", "GBP", "SEK", "JPY", "KWD"] as const;
const CURRENCY_NAMES: Record<(typeof CURRENCIES)[number], string> = {
  NGN: "Nigerian Naira",
  EUR: "Euro",
  USD: "US Dollar",
  GBP: "British Pound",
  SEK: "Swedish Krona",
  JPY: "Japanese Yen",
  KWD: "Kuwaiti Dinar",
};
const CONTENT_MAX_LENGTH = 500;
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

function defaultLocalParts(): { date: string; time: string } {
  const now = new Date(Date.now() + 48 * 3600 * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function PublishForm({ onPublished }: { onPublished: (activity: ActivityView) => void }): ReactNode {
  const { authorized } = useSession();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [itinerary, setItinerary] = useState("");
  const [wall, setWall] = useState(defaultLocalParts);
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
        startsAt = localWallToUtcInstant(`${wall.date}T${wall.time}`, timeZone).toISOString();
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
      <div className="breadcrumb">
        <span>My activities</span>
        <span aria-hidden="true">/</span>
        <span className="crumb-current">New activity</span>
      </div>
      <h2 id="publish-heading" className="detail-title">Publish an activity</h2>
      <p className="page-sub">Create a plan people can discover and book.</p>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="form-section">
          <div className="form-section-head">
            <span className="section-num">1</span>
            <div>
              <h2>About the activity</h2>
              <p className="section-sub">Tell guests what to expect.</p>
            </div>
          </div>
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
          <div className="field-with-count">
            <textarea id="pub-description" maxLength={CONTENT_MAX_LENGTH} value={description} onChange={event => setDescription(event.target.value)} aria-invalid={!!fieldErrors.description} aria-describedby="pub-description-error" />
            <span className="field-count">{description.length}/{CONTENT_MAX_LENGTH}</span>
          </div>
          {fieldErrors.description && <p id="pub-description-error" className="field-error" role="alert">{fieldErrors.description}</p>}
          <label htmlFor="pub-itinerary">Itinerary</label>
          <div className="field-with-count">
            <textarea id="pub-itinerary" maxLength={CONTENT_MAX_LENGTH} value={itinerary} onChange={event => setItinerary(event.target.value)} aria-invalid={!!fieldErrors.itinerary} aria-describedby="pub-itinerary-error" />
            <span className="field-count">{itinerary.length}/{CONTENT_MAX_LENGTH}</span>
          </div>
          {fieldErrors.itinerary && <p id="pub-itinerary-error" className="field-error" role="alert">{fieldErrors.itinerary}</p>}
        </div>

        <div className="form-section">
          <div className="form-section-head">
            <span className="section-num">2</span>
            <div>
              <h2>When and booking</h2>
              <p className="section-sub">Choose when it happens and how guests can book.</p>
            </div>
          </div>
          <div className="form-grid-3">
            <div>
              <label htmlFor="pub-date">Date</label>
              <input
                id="pub-date"
                type="date"
                value={wall.date}
                onChange={(event) => setWall(previous => ({ ...previous, date: event.target.value }))}
                aria-invalid={fieldErrors.startsAt !== undefined}
                aria-describedby={fieldErrors.startsAt !== undefined ? "pub-starts-error" : undefined}
              />
            </div>
            <div>
              <label htmlFor="pub-time">Start time</label>
              <input
                id="pub-time"
                type="time"
                value={wall.time}
                onChange={(event) => setWall(previous => ({ ...previous, time: event.target.value }))}
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

          <div className="form-grid-3">
            <div>
              <label htmlFor="pub-spots">Spots available</label>
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
              <label htmlFor="pub-price">Price per person</label>
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
                  <option key={code} value={code}>{code} — {CURRENCY_NAMES[code]}</option>
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
        </div>

        {formError !== null && (
          <div className="notice notice-warn" role="alert">
            {formError} Your entries are kept — adjust and submit again.
          </div>
        )}
        <div className="form-footer">
          <span className="form-footer-note"><InfoIcon /> Your activity will be visible to guests after you publish it.</span>
          <button type="submit" className="button-primary" disabled={pending}>
            {pending ? "Publishing…" : "Publish activity"}
          </button>
        </div>
      </form>
    </section>
  );
}
