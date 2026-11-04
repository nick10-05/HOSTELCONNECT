import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { getStructure, type Building } from "../api/structure";
import { transferStudent, type Stay, type TransferredStay } from "../api/students";
import { hostelToday } from "./admissionForm";
import { formatDate } from "./format";
import { PlacePicker, withPlaceChange, type PlaceValues } from "./PlacePicker";
import { primaryButton, secondaryButton } from "./styles";

// Moving a current student (design doc, section 9), opened from the profile. The server
// decides what happens; the form only says it in advance:
// - a student who has joined is transferred: the current stay ends today and a new one
//   starts today, so the old one stays in the history;
// - a student whose stay has not started (a future joining date) only has the assignment
//   changed, with no history (decided on day 5).

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const idText = (id: number | null) => (id === null ? "" : String(id));

// Whether the chosen bed can still be taken in this (fresh) tree: free and not retired,
// or the student's own bed.
function bedStillFree(buildings: Building[], bedId: string, currentBedId: number | null): boolean {
  if (!bedId || Number(bedId) === currentBedId) return true;
  const beds = buildings.flatMap((b) => [...b.floors.flatMap((f) => f.rooms), ...b.rooms]).flatMap((r) => r.beds);
  const bed = beds.find((b) => String(b.id) === bedId);
  return bed !== undefined && bed.isActive && !bed.occupied;
}

export function TransferForm({
  studentId,
  stay,
  onDone,
  onCancel,
}: {
  studentId: number;
  stay: Stay; // the current stay
  onDone: (result: TransferredStay) => void;
  onCancel: () => void;
}) {
  const current: PlaceValues = {
    buildingId: String(stay.buildingId),
    roomId: idText(stay.roomId),
    bedId: idText(stay.bedId),
  };
  const [buildings, setBuildings] = useState<Building[] | null>(null);
  const [values, setValues] = useState<PlaceValues>(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getStructure()
      .then((b) => live && setBuildings(b))
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, []);

  const notStarted = stay.startedOn > hostelToday();
  // The server refuses a move to the same place (409 same_place); do not offer it.
  const unchanged =
    values.buildingId === current.buildingId &&
    values.roomId === current.roomId &&
    values.bedId === current.bedId;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      onDone(
        await transferStudent(studentId, {
          buildingId: Number(values.buildingId),
          roomId: values.roomId ? Number(values.roomId) : null,
          bedId: values.bedId ? Number(values.bedId) : null,
        }),
      );
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      // The refusal may come from a change elsewhere (most often a bed someone else just
      // took), so show the beds as they are now and let go of a choice that has gone.
      getStructure()
        .then((fresh) => {
          setBuildings(fresh);
          setValues((v) => (bedStillFree(fresh, v.bedId, stay.bedId) ? v : { ...v, bedId: "" }));
        })
        .catch(() => {
          // The refusal message is already shown; the old list stays.
        });
    }
  };

  const cancel = (
    <button type="button" onClick={onCancel} disabled={busy} className={secondaryButton}>
      Cancel
    </button>
  );

  return (
    <section
      aria-labelledby="transfer-heading"
      className="space-y-4 rounded-xl border border-indigo-200 bg-white p-4 shadow-sm"
    >
      <h2 id="transfer-heading" className="text-sm font-semibold text-slate-700">
        {notStarted ? "Change room or bed" : "Transfer"}
      </h2>
      <p className="text-sm text-slate-600">
        {notStarted
          ? `Joins on ${formatDate(stay.startedOn)}: this only changes the assignment, no history is kept.`
          : "The current stay ends today and the new one starts today."}
      </p>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {buildings === null ? (
        // Loading, or the buildings could not be loaded: the owner can always back out.
        <div className="space-y-4">
          {!error && <p className="text-sm text-slate-500">Loading…</p>}
          {cancel}
        </div>
      ) : (
        <form noValidate onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <PlacePicker
              buildings={buildings}
              values={values}
              onChange={(name, value) => setValues((v) => withPlaceChange(v, name, value))}
              currentBedId={stay.bedId}
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={busy || unchanged || !values.buildingId} className={primaryButton}>
              {busy ? "Saving…" : notStarted ? "Save new room or bed" : "Transfer student"}
            </button>
            {cancel}
          </div>
        </form>
      )}
    </section>
  );
}
