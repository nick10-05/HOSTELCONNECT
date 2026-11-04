import { useId, type ReactNode } from "react";
import type { Building, Room } from "../api/structure";
import { inputClass } from "./styles";

// Building, room and bed choices, shared by the admission form and the transfer form so
// both offer exactly the same places. Room and bed are offered only where the owner has
// built them; a taken or retired bed is shown but cannot be chosen.

// The three choices as the selects hold them: an id as text, "" for none.
export type PlaceValues = { buildingId: string; roomId: string; bedId: string };
export type PlaceErrors = Partial<Record<keyof PlaceValues, string>>;

const floorLabel = (number: number) => (number === 0 ? "Ground floor" : `Floor ${number}`);

// Every room of a building, with its floor, in the order the structure screen shows them.
type RoomChoice = { room: Room; label: string };
function roomsOf(building: Building | undefined): RoomChoice[] {
  if (!building) return [];
  return [
    ...building.floors.flatMap((f) =>
      f.rooms.map((room) => ({ room, label: `${room.roomNumber} · ${floorLabel(f.number)}` })),
    ),
    ...building.rooms.map((room) => ({ room, label: room.roomNumber })),
  ];
}

// Each form keeps its own values and sets a field through this: changing the building
// forgets the room and bed, changing the room forgets the bed, so a stale choice is never
// sent. Any other field is simply set.
export function withPlaceChange<V extends PlaceValues>(v: V, name: keyof V, value: string): V {
  return {
    ...v,
    [name]: value,
    ...(name === "buildingId" && { roomId: "", bedId: "" }),
    ...(name === "roomId" && { bedId: "" }),
  };
}

export function PlacePicker({
  buildings,
  values,
  errors = {},
  onChange,
  currentBedId = null,
}: {
  buildings: Building[];
  values: PlaceValues;
  errors?: PlaceErrors;
  onChange: (name: keyof PlaceValues, value: string) => void;
  // The bed the student already holds (transfer form): marked "(current)" and not
  // disabled, although it counts as occupied.
  currentBedId?: number | null;
}) {
  const building = buildings.find((b) => String(b.id) === values.buildingId);
  const rooms = roomsOf(building);
  const room = rooms.find((r) => String(r.room.id) === values.roomId)?.room;
  const props = { values, errors, onChange };

  return (
    <>
      <PlaceSelect {...props} name="buildingId" label="Building">
        <option value="">Choose…</option>
        {buildings.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </PlaceSelect>
      {rooms.length > 0 && (
        <PlaceSelect {...props} name="roomId" label="Room (optional)">
          <option value="">No room yet</option>
          {rooms.map(({ room: r, label }) => (
            <option key={r.id} value={r.id}>
              {label}
            </option>
          ))}
        </PlaceSelect>
      )}
      {room && room.beds.length > 0 && (
        <PlaceSelect {...props} name="bedId" label="Bed (optional)">
          <option value="">No bed yet</option>
          {room.beds.map((b) => {
            const note =
              b.id === currentBedId
                ? " (current)"
                : !b.isActive
                  ? " (retired)"
                  : b.occupied
                    ? " (occupied)"
                    : "";
            return (
              <option key={b.id} value={b.id} disabled={note !== "" && b.id !== currentBedId}>
                {b.bedNumber}
                {note}
              </option>
            );
          })}
        </PlaceSelect>
      )}
    </>
  );
}

function PlaceSelect({
  values,
  errors,
  onChange,
  name,
  label,
  children,
}: {
  values: PlaceValues;
  errors: PlaceErrors;
  onChange: (name: keyof PlaceValues, value: string) => void;
  name: keyof PlaceValues;
  label: string;
  children: ReactNode;
}) {
  // The label, the error under the field, and the links between them that screen readers
  // (and the tests) follow.
  const id = useId();
  const error = errors[name];
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <select
        id={id}
        value={values[name]}
        onChange={(e) => onChange(name, e.target.value)}
        className={inputClass}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      >
        {children}
      </select>
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
