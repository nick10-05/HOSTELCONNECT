import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api/client";
import {
  addBed,
  addFloor,
  addRoom,
  createBuilding,
  deleteBuilding,
  deleteFloor,
  deleteRoom,
  getStructure,
  setBedActive,
  type Bed,
  type Building,
  type Room,
} from "../api/structure";

// The owner's screen for buildings, floors, rooms and beds. Every change is sent to the
// server and then the whole tree is loaded again: a little more traffic, but the
// screen always shows exactly what the server saved (≤200 beds, so it stays small).

type Change = (action: () => Promise<void>) => Promise<boolean>;

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const floorLabel = (number: number) => (number === 0 ? "Ground floor" : `Floor ${number}`);

const inputClass =
  "block w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none";
const primaryButton =
  "rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60";
const quietButton =
  "rounded px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60";
const dangerButton =
  "rounded px-2 py-1 text-sm text-red-600 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60";

export function StructurePage() {
  const [buildings, setBuildings] = useState<Building[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setBuildings(await getStructure()), []);

  useEffect(() => {
    load().catch((err: unknown) => setError(errorText(err)));
  }, [load]);

  // Runs one change, then reloads. Returns whether it worked, so a form can clear itself.
  // One change at a time: every button is disabled while busy.
  const change: Change = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Buildings and rooms</h1>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {buildings === null ? (
        !error && <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          {buildings.length === 0 && (
            <p className="text-sm text-slate-600">No buildings yet. Add your first building below.</p>
          )}
          {buildings.map((b) => (
            <BuildingCard key={b.id} building={b} busy={busy} change={change} />
          ))}
          <SingleFieldForm
            label="New building name"
            button="Add building"
            busy={busy}
            onSubmit={(name) => change(() => createBuilding(name))}
          />
        </>
      )}
    </div>
  );
}

type CardProps = { building: Building; busy: boolean; change: Change };

function BuildingCard({ building, busy, change }: CardProps) {
  const headingId = `building-${building.id}`;
  const remove = () => {
    if (window.confirm(`Delete ${building.name} with all its floors, rooms and beds?`)) {
      void change(() => deleteBuilding(building.id));
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold text-slate-900">
          {building.name}
        </h2>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          aria-label={`Delete building ${building.name}`}
          className={dangerButton}
        >
          Delete
        </button>
      </div>

      {building.floors.map((floor) => {
        const label = floorLabel(floor.number);
        return (
          <Group
            key={floor.id}
            title={label}
            action={
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Delete ${label} of ${building.name}?`)) {
                    void change(() => deleteFloor(floor.id));
                  }
                }}
                disabled={busy}
                aria-label={`Delete ${label.toLowerCase()}`}
                className={dangerButton}
              >
                Delete
              </button>
            }
          >
            {floor.rooms.length === 0 && <p className="text-sm text-slate-500">No rooms yet.</p>}
            {floor.rooms.map((room) => (
              <RoomRow key={room.id} room={room} busy={busy} change={change} />
            ))}
          </Group>
        );
      })}

      {building.rooms.length > 0 && (
        <Group title="No floor">
          {building.rooms.map((room) => (
            <RoomRow key={room.id} room={room} busy={busy} change={change} />
          ))}
        </Group>
      )}

      <div className="grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
        <FloorForm building={building} busy={busy} change={change} />
        <RoomForm building={building} busy={busy} change={change} />
      </div>
    </section>
  );
}

function Group({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">{title}</h3>
        {action}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function RoomRow({ room, busy, change }: { room: Room; busy: boolean; change: Change }) {
  const name = `room ${room.roomNumber}`;
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-slate-900">Room {room.roomNumber}</span>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Delete ${name} and its beds?`)) void change(() => deleteRoom(room.id));
          }}
          disabled={busy}
          aria-label={`Delete ${name}`}
          className={dangerButton}
        >
          Delete
        </button>
      </div>

      {room.beds.length > 0 && (
        <ul aria-label={`Beds in ${name}`} className="mt-2 divide-y divide-slate-100">
          {room.beds.map((bed) => (
            <BedRow key={bed.id} bed={bed} busy={busy} change={change} />
          ))}
        </ul>
      )}

      <div className="mt-2">
        <SingleFieldForm
          label={`New bed in ${name}`}
          button="Add bed"
          buttonLabel={`Add bed to ${name}`}
          busy={busy}
          compact
          onSubmit={(bedNumber) => change(() => addBed(room.id, bedNumber))}
        />
      </div>
    </div>
  );
}

function BedRow({ bed, busy, change }: { bed: Bed; busy: boolean; change: Change }) {
  const status = !bed.isActive ? "Retired" : bed.occupied ? "Occupied" : "Free";
  const badge = {
    Retired: "bg-slate-100 text-slate-500",
    Occupied: "bg-amber-50 text-amber-700",
    Free: "bg-emerald-50 text-emerald-700",
  }[status];

  return (
    <li className="flex items-center justify-between gap-2 py-1.5">
      <span className="flex items-center gap-2">
        <span className="text-sm text-slate-800">Bed {bed.bedNumber}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge}`}>{status}</span>
      </span>
      {/* Someone sleeps in an occupied bed, so it cannot be retired (the server refuses too). */}
      {!bed.occupied && (
        <button
          type="button"
          onClick={() => void change(() => setBedActive(bed.id, !bed.isActive))}
          disabled={busy}
          aria-label={bed.isActive ? `Retire bed ${bed.bedNumber}` : `Bring back bed ${bed.bedNumber}`}
          className={quietButton}
        >
          {bed.isActive ? "Retire" : "Bring back"}
        </button>
      )}
    </li>
  );
}

function FloorForm({ building, busy, change }: CardProps) {
  const [number, setNumber] = useState("");
  const id = `floor-number-${building.id}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await change(() => addFloor(building.id, Number(number)))) setNumber("");
  }

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <div className="flex-1">
        <label htmlFor={id} className="block text-sm font-medium text-slate-700">
          Floor number
        </label>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={99}
          step={1}
          required
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="0 = ground"
          className={`mt-1 ${inputClass}`}
        />
      </div>
      <button type="submit" disabled={busy} className={primaryButton}>
        Add floor
      </button>
    </form>
  );
}

function RoomForm({ building, busy, change }: CardProps) {
  const [roomNumber, setRoomNumber] = useState("");
  const [floorId, setFloorId] = useState("");
  const numberId = `room-number-${building.id}`;
  const floorSelectId = `room-floor-${building.id}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const floor = floorId === "" ? null : Number(floorId);
    if (await change(() => addRoom(building.id, roomNumber.trim(), floor))) setRoomNumber("");
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2">
        <div className="flex-1">
          <label htmlFor={numberId} className="block text-sm font-medium text-slate-700">
            Room number
          </label>
          <input
            id={numberId}
            required
            maxLength={20}
            value={roomNumber}
            onChange={(e) => setRoomNumber(e.target.value)}
            className={`mt-1 ${inputClass}`}
          />
        </div>
        <div className="flex-1">
          <label htmlFor={floorSelectId} className="block text-sm font-medium text-slate-700">
            On floor
          </label>
          <select
            id={floorSelectId}
            value={floorId}
            onChange={(e) => setFloorId(e.target.value)}
            className={`mt-1 ${inputClass}`}
          >
            <option value="">No floor</option>
            {building.floors.map((f) => (
              <option key={f.id} value={String(f.id)}>
                {floorLabel(f.number)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <button type="submit" disabled={busy} className={primaryButton}>
        Add room
      </button>
    </form>
  );
}

type SingleFieldProps = {
  label: string;
  button: string;
  // Spoken name of the button when the visible word alone is ambiguous ("Add bed").
  buttonLabel?: string;
  busy: boolean;
  compact?: boolean;
  onSubmit: (value: string) => Promise<boolean>;
};

// A text box and a button. The label is read by screen readers; compact forms hide it
// and show it as the placeholder instead.
function SingleFieldForm({ label, button, buttonLabel, busy, compact, onSubmit }: SingleFieldProps) {
  const [value, setValue] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await onSubmit(value.trim())) setValue("");
  }

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <label className="flex-1">
        <span className={compact ? "sr-only" : "block text-sm font-medium text-slate-700"}>{label}</span>
        <input
          required
          maxLength={100}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={compact ? label : undefined}
          className={`${compact ? "" : "mt-1"} ${inputClass}`}
        />
      </label>
      <button type="submit" disabled={busy} aria-label={buttonLabel} className={primaryButton}>
        {button}
      </button>
    </form>
  );
}
