import { createContext, useContext } from "react";
import type { Account } from "../api/auth";
import type { Hostel } from "../api/hostels";

// The signed-in user's hostel, from GET /api/auth/me (multi-tenant phase 3a). Null
// outside the signed-in app, or when the server sent none.
export const HostelContext = createContext<Hostel | null>(null);

export const useHostel = () => useContext(HostelContext);

// How the signed-in user signs in, and whether Google sign-in is set up (phase 3b). Null
// outside the signed-in app, or when the server sent none.
export const AccountContext = createContext<(Account & { googleEnabled: boolean }) | null>(null);

export const useAccount = () => useContext(AccountContext);
