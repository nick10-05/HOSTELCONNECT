import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router";
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
import { SettingsPage } from "./owner/SettingsPage";
import { StructurePage } from "./owner/StructurePage";
import { StudentProfilePage } from "./owner/StudentProfilePage";
import { StudentsPage } from "./owner/StudentsPage";
import { ComplaintDetailPage } from "./student/ComplaintDetailPage";
import { MyFeesPage } from "./student/MyFeesPage";
import { NewComplaintPage } from "./student/NewComplaintPage";
import { NoticesPage } from "./student/NoticesPage";
import { StudentHome } from "./student/StudentHome";
import { IconTile, type Tone } from "./ui";
import { BottomSheet } from "./ui/BottomSheet";
import {
  BuildingIcon,
  FoodIcon,
  GridIcon,
  HomeIcon,
  MegaphoneIcon,
  MessageIcon,
  PlusIcon,
  ReturnIcon,
  RupeeIcon,
  SettingsIcon,
  SignOutIcon,
  UserPlusIcon,
  UsersIcon,
} from "./ui/icons";
import { ToastProvider } from "./ui/Toast";
import { ThemeSwitch } from "./ui/theme";

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
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-app text-sm text-muted">
        <span aria-hidden="true" className="bg-active flex size-12 animate-pulse items-center justify-center rounded-2xl font-display text-xl font-extrabold">
          H
        </span>
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
  // On a phone the menu is a tab bar floating at the bottom; from md up it is a sidebar.
  return (
    <ToastProvider>
      <div className="min-h-dvh bg-app">
        <header className="sticky top-0 z-40 px-3 pt-2.5 md:px-6">
          <div className="glass mx-auto flex max-w-6xl items-center justify-between gap-3 rounded-[22px] py-2 pr-2 pl-3 shadow-[0_8px_24px_-16px_rgb(10_10_15/0.3)]">
            <Link to="/" className="flex min-h-11 items-center gap-2.5 rounded-xl">
              <span
                aria-hidden="true"
                className="bg-active flex size-9 items-center justify-center rounded-xl font-display text-base font-extrabold"
              >
                H
              </span>
              <span className="font-display text-base font-extrabold tracking-tight text-ink">HostelConnect</span>
            </Link>
            <div className="flex items-center gap-2">
              <ThemeSwitch />
              <NotificationBell />
              <button
                type="button"
                onClick={signOut}
                aria-label="Sign out"
                className="press flex h-11 items-center gap-2 rounded-[15px] px-3 text-sm font-semibold text-muted hover:bg-soft hover:text-ink"
              >
                <SignOutIcon size={20} />
                <span aria-hidden="true" className="hidden sm:inline">
                  Sign out
                </span>
              </button>
            </div>
          </div>
        </header>

        <div className="mx-auto flex max-w-6xl gap-6 px-4 md:px-6">
          {user.role === "owner" ? <OwnerNav /> : <StudentNav />}
          <main className="min-w-0 flex-1 pt-6 pb-32 md:pt-8 md:pb-16">
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
                <Route path="/settings" element={<SettingsPage />} />
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
                    <StudentHome name={user.name} />
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
      </div>
    </ToastProvider>
  );
}

// The menu: a floating glass tab bar on a phone, a sidebar from md up.
const navClass =
  "glass fixed inset-x-3 bottom-3 z-30 flex gap-1 rounded-[26px] p-1.5 shadow-[0_18px_40px_-14px_rgb(10_10_15/0.35)] md:sticky md:top-24 md:bottom-auto md:z-0 md:mt-8 md:h-fit md:w-56 md:shrink-0 md:flex-col md:rounded-3xl md:p-2";

const tabClass = (active: boolean) =>
  `press flex min-h-[54px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[20px] px-1 text-[11px] font-semibold md:min-h-11 md:flex-none md:flex-row md:justify-start md:gap-3 md:rounded-xl md:px-3 md:text-sm ${
    active ? "bg-active" : "text-muted hover:text-ink md:hover:bg-soft"
  }`;

const navLinkClass = ({ isActive }: { isActive: boolean }) => tabClass(isActive);

type Page = { to: string; label: string; Icon: typeof HomeIcon; tone: Tone; end?: boolean };

// The four pages the owner opens most sit on the tab bar; the rest are under More.
const ownerTabs: Page[] = [
  // end: highlighted on the home page only, not on every page below it
  { to: "/", label: "Home", Icon: HomeIcon, tone: "violet", end: true },
  // end: highlighted on the directory only, not while admitting at /students/new
  { to: "/students", label: "Students", Icon: UsersIcon, tone: "violet", end: true },
  { to: "/complaints", label: "Complaints", Icon: MessageIcon, tone: "amber" },
  { to: "/fees", label: "Fees", Icon: RupeeIcon, tone: "green" },
];
const ownerMore: Page[] = [
  { to: "/structure", label: "Buildings", Icon: BuildingIcon, tone: "blue" },
  { to: "/students/new", label: "Admit student", Icon: PlusIcon, tone: "violet" },
  { to: "/rejoin-requests", label: "Rejoin requests", Icon: UserPlusIcon, tone: "blue" },
  { to: "/announcements", label: "Announcements", Icon: MegaphoneIcon, tone: "pink" },
  // Highlighted on a poll's own page too.
  { to: "/return-polls", label: "Return polls", Icon: ReturnIcon, tone: "orange" },
  { to: "/food-counts", label: "Food counts", Icon: FoodIcon, tone: "green" },
  { to: "/settings", label: "Settings", Icon: SettingsIcon, tone: "violet" },
];

function OwnerNav() {
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();

  // Any move to another page closes the More menu.
  useEffect(() => setMoreOpen(false), [pathname]);

  return (
    <>
      <nav aria-label="Owner pages" className={navClass}>
        {ownerTabs.map(({ to, label, Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={navLinkClass}>
            <Icon />
            <span className="truncate">{label}</span>
          </NavLink>
        ))}
        {/* From md up the rest of the pages are in the sidebar; on a phone, under More. */}
        <div className="hidden md:mt-1 md:flex md:flex-col md:gap-1 md:border-t md:border-line md:pt-2">
          {ownerMore.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} className={navLinkClass}>
              <Icon />
              <span className="truncate">{label}</span>
            </NavLink>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          className={`${tabClass(ownerMore.some((p) => pathname.startsWith(p.to)))} md:hidden`}
        >
          <GridIcon />
          <span>More</span>
        </button>
      </nav>

      <BottomSheet open={moreOpen} title="More pages" onClose={() => setMoreOpen(false)}>
        <ul className="grid grid-cols-3 gap-x-2 gap-y-4">
          {ownerMore.map(({ to, label, Icon, tone }) => (
            <li key={to}>
              <Link
                to={to}
                onClick={() => setMoreOpen(false)}
                className="press flex flex-col items-center gap-2 rounded-2xl p-1 text-center text-xs font-semibold text-ink"
              >
                <IconTile tone={tone} size="lg">
                  <Icon />
                </IconTile>
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </BottomSheet>
    </>
  );
}

// The student's few pages. "My complaints" stays highlighted on a complaint's own page.
function StudentNav() {
  const { pathname } = useLocation();
  return (
    <nav aria-label="Student pages" className={navClass}>
      <NavLink
        to="/"
        className={({ isActive }) => tabClass(isActive || pathname.startsWith("/complaints"))}
        end
      >
        <HomeIcon />
        <span className="truncate">My complaints</span>
      </NavLink>
      <NavLink to="/notices" className={navLinkClass}>
        <MegaphoneIcon />
        <span className="truncate">Notices</span>
      </NavLink>
      <NavLink to="/fees" className={navLinkClass}>
        <RupeeIcon />
        <span className="truncate">My fees</span>
      </NavLink>
    </nav>
  );
}
