import { createContext, useContext } from "react";
import type { Hostel } from "../api/hostels";

// The signed-in user's hostel, from GET /api/auth/me (multi-tenant phase 3a). Null
// outside the signed-in app, or when the server sent none.
export const HostelContext = createContext<Hostel | null>(null);

export const useHostel = () => useContext(HostelContext);
