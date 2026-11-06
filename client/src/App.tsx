import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { logout, me, type User } from "./api/auth";
import { ChangePasswordPage } from "./auth/ChangePasswordPage";
import { LoginPage } from "./auth/LoginPage";
import { RequestAccessPage } from "./auth/RequestAccessPage";
import { NotificationBell } from "./components/NotificationBell";
import { AdmitStudentPage } from "./owner/AdmitStudentPage";
import { AnnouncementsPage } from "./owner/AnnouncementsPage";
import { ComplaintPage } from "./owner/ComplaintPage";
import { ComplaintsPage } from "./owner/ComplaintsPage";
import { DashboardPage } from "./owner/DashboardPage";
import { FeesPage } from "./owner/FeesPage";
import { FoodCountsPage } from "./owner/FoodCountsPage";
import { RejoinRequestsPage } from "./owner/RejoinRequestsPage";
import { ReturnPollPage } from "./owner/ReturnPollPage";
import { ReturnPollsPage } from "./owner/ReturnPollsPage";
import { StructurePage } from "./owner/StructurePage";
import { StudentProfilePage } from "./owner/StudentProfilePage";
import { StudentsPage } from "./owner/StudentsPage";
import { ComplaintDetailPage } from "./student/ComplaintDetailPage";
import { MyComplaintsPage } from "./student/MyComplaintsPage";
import { MyFeesCard, MyFeesPage } from "./student/MyFeesPage";
import { NewComplaintPage } from "./student/NewComplaintPage";
import { ImportantNotices, NoticesPage } from "./student/NoticesPage";
import { ReturnPollTile } from "./student/ReturnPollTile";

type Session = { status: "loading" } | { status: "anonymous" } | { status: "signed-in"; user: User };

export function App() {
  const [session, setSession] = useState<Session>({ status: "loading" });

  // The cookie is httpOnly, so JavaScript cannot see it: ask the server who we are.
  useEffect(() => {
    me()
      .then((user) => setSession({ status: "signed-in", user }))
      .catch(() => setSession({ status: "anonymous" }));
  }, []);

  const signIn = (user: User) => setSession({ status: "signed-in", user });
  const signOut = () => {
    void logout().finally(() => setSession({ status: "anonymous" }));
  };

  if (session.status === "loading") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading…
      </main>
    );
  }

  // Signed out: the request form for former students, and the sign-in page everywhere else.
  if (session.status === "anonymous") {
    return (
      <Routes>
        <Route path="/request-access" element={<RequestAccessPage />} />
        <Route path="*" element={<LoginPage onLoggedIn={signIn} />} />
      </Routes>
    );
  }

  const { user } = session;

  // A temporary password unlocks nothing else (the server enforces the same rule).
  if (user.mustChangePassword) {
    return <ChangePasswordPage user={user} onChanged={signIn} onSignOut={signOut} />;
  }

  // The owner's pages, or the student's (complaints, notices, the return poll and fees).
  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <span className="font-semibold text-slate-900">HostelConnect</span>
          {user.role === "owner" ? <OwnerNav /> : <StudentNav />}
          <div className="flex items-center gap-3">
            <NotificationBell />
            <button
              type="button"
              onClick={signOut}
              className="text-sm text-slate-600 hover:text-slate-900"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        {user.role === "owner" ? (
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/structure" element={<StructurePage />} />
            <Route path="/students" element={<StudentsPage />} />
            <Route path="/students/new" element={<AdmitStudentPage />} />
            <Route path="/students/:id" element={<StudentProfilePage />} />
            <Route path="/rejoin-requests" element={<RejoinRequestsPage />} />
            <Route path="/complaints" element={<ComplaintsPage />} />
            <Route path="/complaints/:id" element={<ComplaintPage />} />
            <Route path="/announcements" element={<AnnouncementsPage />} />
            <Route path="/return-polls" element={<ReturnPollsPage />} />
            <Route path="/return-polls/:id" element={<ReturnPollPage />} />
            <Route path="/food-counts" element={<FoodCountsPage />} />
            <Route path="/fees" element={<FeesPage />} />
            {/* The owner starts on the dashboard; unknown addresses go there too
                instead of showing a blank page. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        ) : (
          <Routes>
            {/* Section 9: urgent and pinned notices first, then an open return poll,
                the complaints, and the fees. */}
            <Route
              path="/"
              element={
                <div className="space-y-8">
                  <ImportantNotices />
                  <ReturnPollTile />
                  <MyComplaintsPage />
                  <MyFeesCard />
                </div>
              }
            />
            <Route path="/complaints/new" element={<NewComplaintPage />} />
            <Route path="/complaints/:id" element={<ComplaintDetailPage />} />
            <Route path="/notices" element={<NoticesPage />} />
            <Route path="/fees" element={<MyFeesPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium ${
    isActive ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
  }`;

// One entry per owner page; later days add theirs here.
function OwnerNav() {
  return (
    <nav aria-label="Owner pages" className="order-last flex w-full flex-wrap gap-1 sm:order-none sm:w-auto">
      {/* end: highlighted on the home page only, not on every page below it */}
      <NavLink to="/" end className={navLinkClass}>
        Dashboard
      </NavLink>
      <NavLink to="/structure" className={navLinkClass}>
        Buildings
      </NavLink>
      {/* end: highlighted on the directory only, not while admitting at /students/new */}
      <NavLink to="/students" end className={navLinkClass}>
        Students
      </NavLink>
      <NavLink to="/students/new" className={navLinkClass}>
        Admit student
      </NavLink>
      <NavLink to="/rejoin-requests" className={navLinkClass}>
        Rejoin requests
      </NavLink>
      <NavLink to="/complaints" className={navLinkClass}>
        Complaints
      </NavLink>
      <NavLink to="/announcements" className={navLinkClass}>
        Announcements
      </NavLink>
      {/* Highlighted on a poll's own page too. */}
      <NavLink to="/return-polls" className={navLinkClass}>
        Return polls
      </NavLink>
      <NavLink to="/food-counts" className={navLinkClass}>
        Food counts
      </NavLink>
      <NavLink to="/fees" className={navLinkClass}>
        Fees
      </NavLink>
    </nav>
  );
}

// The student's few pages. "My complaints" stays highlighted on a complaint's own page.
function StudentNav() {
  const { pathname } = useLocation();
  return (
    <nav aria-label="Student pages" className="order-last flex w-full flex-wrap gap-1 sm:order-none sm:w-auto">
      <NavLink
        to="/"
        className={({ isActive }) => navLinkClass({ isActive: isActive || pathname.startsWith("/complaints") })}
        end
      >
        My complaints
      </NavLink>
      <NavLink to="/notices" className={navLinkClass}>
        Notices
      </NavLink>
      <NavLink to="/fees" className={navLinkClass}>
        My fees
      </NavLink>
    </nav>
  );
}
