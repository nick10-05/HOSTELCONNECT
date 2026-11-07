import type { ReactNode, SVGProps } from "react";

// A small set of line icons drawn for HostelConnect (24×24, 1.8 stroke), so the app needs
// no icon library. They are decoration: hidden from screen readers, so the text or the
// aria-label next to them names the thing.

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function make(paths: ReactNode, name: string) {
  function Icon({ size = 22, ...props }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...props}
      >
        {paths}
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

export const HomeIcon = make(<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />, "HomeIcon");
export const UsersIcon = make(
  <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" />
    <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.9.7 3.1 2.5 3.5 5.2" />
  </>,
  "UsersIcon",
);
export const UserPlusIcon = make(
  <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" />
    <path d="M19 8v6M16 11h6" />
  </>,
  "UserPlusIcon",
);
export const MessageIcon = make(<path d="M4 5h16v11H9l-5 4z" />, "MessageIcon");
export const RupeeIcon = make(<path d="M7 4h11M7 8.5h11M7 4h3.5a4.5 4.5 0 0 1 0 9H7l8 7" />, "RupeeIcon");
export const GridIcon = make(
  <>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
  </>,
  "GridIcon",
);
export const BellIcon = make(
  <>
    <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </>,
  "BellIcon",
);
export const SearchIcon = make(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4-4" />
  </>,
  "SearchIcon",
);
export const FilterIcon = make(
  <>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </>,
  "FilterIcon",
);
export const PlusIcon = make(<path d="M12 5v14M5 12h14" />, "PlusIcon");
export const ChevronRightIcon = make(<path d="m9 6 6 6-6 6" />, "ChevronRightIcon");
export const ChevronLeftIcon = make(<path d="m15 6-6 6 6 6" />, "ChevronLeftIcon");
export const CloseIcon = make(<path d="M6 6l12 12M18 6 6 18" />, "CloseIcon");
export const CheckIcon = make(<path d="m5 12.5 4.5 4.5L19 7.5" />, "CheckIcon");
export const BedIcon = make(
  <>
    <path d="M3 18V7M3 14h18v4M21 14v-3a3 3 0 0 0-3-3h-7v6" />
    <circle cx="7" cy="11" r="2" />
  </>,
  "BedIcon",
);
export const BuildingIcon = make(
  <>
    <path d="M4 21h16M6 21V9l6-5 6 5v12" />
    <path d="M10 21v-5h4v5" />
  </>,
  "BuildingIcon",
);
export const MegaphoneIcon = make(
  <>
    <path d="M4 10v4h3l7 4V6l-7 4z" />
    <path d="M18 9a4 4 0 0 1 0 6" />
  </>,
  "MegaphoneIcon",
);
export const ReturnIcon = make(
  <>
    <path d="M4 12a8 8 0 1 0 2.4-5.7" />
    <path d="M4 4v4h4" />
  </>,
  "ReturnIcon",
);
export const FoodIcon = make(<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 1-3 3.5-3 7h3v11" />, "FoodIcon");
export const SettingsIcon = make(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
  </>,
  "SettingsIcon",
);
export const SignOutIcon = make(<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />, "SignOutIcon");
export const BoltIcon = make(<path d="M13 3 5 14h6l-1 7 8-11h-6z" />, "BoltIcon");
export const DropIcon = make(<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />, "DropIcon");
export const WifiIcon = make(
  <>
    <path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0" />
    <path d="M12 19.5v.01" />
  </>,
  "WifiIcon",
);
export const QrIcon = make(
  <>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <path d="M14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2" />
  </>,
  "QrIcon",
);
export const WarningIcon = make(
  <>
    <path d="M12 4 2.5 20h19z" />
    <path d="M12 10v4M12 17v.5" />
  </>,
  "WarningIcon",
);
export const AlertCircleIcon = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16v.5" />
  </>,
  "AlertCircleIcon",
);
export const InfoIcon = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8v.5" />
  </>,
  "InfoIcon",
);
export const ClockIcon = make(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </>,
  "ClockIcon",
);
export const SunIcon = make(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </>,
  "SunIcon",
);
export const MoonIcon = make(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />, "MoonIcon");
export const AutoThemeIcon = make(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none" />
  </>,
  "AutoThemeIcon",
);
