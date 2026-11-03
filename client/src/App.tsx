import { useEffect, useState } from "react";
import { logout, me, type User } from "./api/auth";
import { LoginPage } from "./auth/LoginPage";

type Session = { status: "loading" } | { status: "anonymous" } | { status: "signed-in"; user: User };

export function App() {
  const [session, setSession] = useState<Session>({ status: "loading" });

  // The cookie is httpOnly, so JavaScript cannot see it: ask the server who we are.
  useEffect(() => {
    me()
      .then((user) => setSession({ status: "signed-in", user }))
      .catch(() => setSession({ status: "anonymous" }));
  }, []);

  if (session.status === "loading") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading…
      </main>
    );
  }

  if (session.status === "anonymous") {
    return <LoginPage onLoggedIn={(user) => setSession({ status: "signed-in", user })} />;
  }

  // Placeholder until the owner and student pages exist (day 3 onwards).
  const { user } = session;
  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <span className="font-semibold text-slate-900">HostelConnect</span>
          <button
            type="button"
            onClick={() => {
              void logout().finally(() => setSession({ status: "anonymous" }));
            }}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <p className="text-slate-700">
          Signed in as <strong>{user.name}</strong> ({user.role}).
        </p>
        {user.mustChangePassword && (
          <p className="mt-2 text-sm text-amber-700">You must change your temporary password.</p>
        )}
      </main>
    </div>
  );
}
