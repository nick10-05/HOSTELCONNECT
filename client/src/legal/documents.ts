// The Terms of Service and the Privacy Policy (multi-tenant phase 4b): plain-language
// drafts, written to match what the app actually does, for a lawyer to review before
// sign-up opens (SIGNUPS_OPEN). Words in [square brackets] are still to be filled in.
//
// LEGAL_VERSION must equal TERMS_VERSION in server/src/lib/legal.ts (a server test
// checks): owners accept the version the server names. Change both whenever either
// document changes in substance.
export const LEGAL_VERSION = "2026-11-draft-1";

// Shown on both pages until the review is done; remove it then.
export const UNDER_REVIEW =
  "Draft under legal review. This text may change before new hostels can sign up, and anyone who signed up will be asked to accept the final version.";

export type Block = string | { list: string[] };
export type Section = { heading: string; blocks: Block[] };
export type LegalDocument = { title: string; summary: string; sections: Section[] };

const CONTACT = "[contact email]";

export const TERMS: LegalDocument = {
  title: "Terms of Service",
  summary:
    "HostelConnect is a free tool, in beta, that helps hostel owners run their hostel and talk to their students. These terms are the agreement between HostelConnect and the owner who signs up a hostel.",
  sections: [
    {
      heading: "1. Who we are, and who these terms are for",
      blocks: [
        "HostelConnect is run by [operator's legal name], [address] (\"we\", \"us\"). These terms apply to the hostel owner who creates a hostel on HostelConnect (\"you\"). By ticking the box at sign-up you accept them, for yourself and for the hostel business you run.",
        "Your students use HostelConnect through the accounts you give them. Their use is covered by our Privacy Policy and by the rules of your hostel; you are responsible for telling them how their information is used (section 5).",
      ],
    },
    {
      heading: "2. The service, and the beta",
      blocks: [
        "HostelConnect lets you set up your buildings, rooms and beds, admit and move students, record fees, share your payment details, take complaints, send notices and run return polls.",
        "It is free during the beta. It runs on free hosting, so it can be slow to wake after a quiet spell, and it may change, pause or stop. We will give you at least 30 days' notice, by a notice in the app, before we stop the service or start charging for it, and you will not be charged unless you agree to pay.",
      ],
    },
    {
      heading: "3. Your account",
      blocks: [
        { list: [
          "You sign in with your Google account. Keep it secure: anyone who can sign in to it can manage your hostel.",
          "One Google account owns one hostel. You must be at least 18 and allowed to run the hostel you sign up.",
          "Give your hostel's real name, and keep the details you enter accurate.",
        ] },
      ],
    },
    {
      heading: "4. Limits",
      blocks: [
        "During the beta each hostel may have up to 300 students and 20 buildings, and a share of storage for complaint photos. We may change these limits, and may raise them for a hostel on request.",
      ],
    },
    {
      heading: "5. Your students' information",
      blocks: [
        "You decide whose information goes into HostelConnect and why. For your students' personal data you are the one responsible under the law (under India's Digital Personal Data Protection Act, 2023, the \"Data Fiduciary\"), and we process it on your behalf and on your instructions (the \"Data Processor\"). In particular, you agree to:",
        { list: [
          "tell your students what you record about them and why, and point them to our Privacy Policy;",
          "collect only what you need to run your hostel;",
          "get a parent's or guardian's verifiable consent before adding a student under 18;",
          "deal with your students' requests to see, correct or delete their information, and ask us when you need our help;",
          "not enter sensitive identity numbers (such as Aadhaar, PAN or passport numbers), health information or bank details into free-text fields.",
        ] },
        "We use your hostel's information only to run HostelConnect for you, as the Privacy Policy describes. We do not sell it or use it for advertising.",
      ],
    },
    {
      heading: "6. Fair use",
      blocks: [
        "Do not use HostelConnect to break the law, to harass anyone, to store information you have no right to hold, or to try to reach another hostel's information or disrupt the service. We may suspend a hostel that does, after telling you why where we can.",
      ],
    },
    {
      heading: "7. Money",
      blocks: [
        "HostelConnect records the fees you set and whether they are marked paid. It does not handle money: students pay you directly, for example by UPI. You are responsible for your fees, receipts and taxes.",
      ],
    },
    {
      heading: "8. Your data when you leave",
      blocks: [
        `You may stop using HostelConnect at any time. Write to ${CONTACT} and we will delete your hostel and everyone's information in it within 30 days, after giving you a copy if you ask for one. Encrypted backups are kept for up to 90 days and then deleted. If we stop the service, we will give you the chance to download a copy first.`,
      ],
    },
    {
      heading: "9. No guarantee, and limits on our responsibility",
      blocks: [
        "We work to keep HostelConnect running and your information safe, with nightly encrypted backups, but a free beta comes with no guarantee: the service is provided as it is. Keep your own record of anything you cannot afford to lose.",
        "As far as the law allows, we are not responsible for indirect losses, such as lost income, and our total responsibility to you is limited to [amount]. Nothing in these terms limits responsibility that the law does not allow to be limited.",
      ],
    },
    {
      heading: "10. Changes to these terms",
      blocks: [
        "If we change these terms in a way that matters, we will tell you in the app and ask you to accept the new version before you carry on. Each version has a date, and we keep a record of which version you accepted and when.",
      ],
    },
    {
      heading: "11. Law, and contact",
      blocks: [
        `These terms are governed by the laws of India, and the courts of [city] have jurisdiction. Questions or complaints: ${CONTACT}.`,
      ],
    },
  ],
};

export const PRIVACY: LegalDocument = {
  title: "Privacy Policy",
  summary:
    "What HostelConnect records, why, who can see it, how long it is kept, and what you can ask for. It covers hostel owners and the students they add.",
  sections: [
    {
      heading: "1. Who is responsible",
      blocks: [
        "Each hostel decides what its owner records about its students. For students' information the hostel owner is responsible (the \"Data Fiduciary\" under India's Digital Personal Data Protection Act, 2023), and HostelConnect, run by [operator's legal name], processes it on the owner's behalf. For owners' own accounts, HostelConnect is responsible.",
      ],
    },
    {
      heading: "2. What we record",
      blocks: [
        "About hostel owners:",
        { list: [
          "your name, and the email and account id of the Google account you sign in with (Google does not give us your Google password);",
          "your hostel's name and address on HostelConnect, and the payment details you choose to show students (UPI ID, payee name, QR picture);",
          "which version of the terms you accepted, and when.",
        ] },
        "About students, entered by the hostel owner:",
        { list: [
          "name, email, phone number and a parent's or guardian's phone number;",
          "whether they study or work, with the college, course and year, or the company and role;",
          "joining date, room and bed, food preference, monthly fee, and the fees recorded as due or paid;",
          "a password, stored only in a scrambled (hashed) form we cannot read back.",
        ] },
        "Created while using the app: complaints and their photos, notices, answers to return polls, requests to rejoin, and in-app notifications.",
        "We do not ask for identity numbers such as Aadhaar, and we do not use analytics, advertising or tracking.",
      ],
    },
    {
      heading: "3. Why we use it",
      blocks: [
        "Only to run the hostel's HostelConnect: to sign people in, show each person what they are allowed to see, and send in-app notices and reminders. We do not sell information, show advertising, or use it to train AI models.",
      ],
    },
    {
      heading: "4. Who can see it",
      blocks: [
        { list: [
          "The hostel's owner sees the information of their own hostel's students.",
          "A student sees their own details, fees, complaints and their hostel's notices, not other students' information.",
          "No hostel can see another hostel's information; the database itself keeps each hostel's records apart.",
          "We look at a hostel's information only to keep the service running, fix a problem the owner reports, or when the law requires it.",
        ] },
      ],
    },
    {
      heading: "5. Services we rely on",
      blocks: [
        "HostelConnect runs on these services, which handle information for us:",
        { list: [
          "Render (the web server) and Supabase (the database and the complaint photos), both in Singapore;",
          "Google, for owners' sign-in;",
          "GitHub, which keeps the nightly backups, encrypted with a key only we hold.",
        ] },
        "Information is therefore stored outside India, in Singapore. These services keep short-lived technical logs, which can include IP addresses.",
      ],
    },
    {
      heading: "6. How long it is kept",
      blocks: [
        { list: [
          "Complaint photos: deleted 48 hours after they are added.",
          "In-app notifications: deleted after 60 days.",
          "A student who moves out keeps a deactivated account, so that the hostel's records stay complete and they can ask to rejoin; the owner can ask us to delete it.",
          "Everything else: for as long as the hostel uses HostelConnect. When a hostel leaves, its information is deleted within 30 days.",
          "Encrypted backups: up to 90 days.",
        ] },
      ],
    },
    {
      heading: "7. Cookies",
      blocks: [
        "One cookie keeps you signed in, for up to 7 days. Short-lived cookies carry a Google sign-in or a sign-up while it is in progress. Your choice of light or dark appearance is stored in your browser. There are no advertising or tracking cookies.",
      ],
    },
    {
      heading: "8. Keeping it safe",
      blocks: [
        "Connections are encrypted (HTTPS), passwords are hashed, complaint photos are shown only through links that expire within a minute, and backups are encrypted. No system is perfectly secure; if a breach affects your information, we will tell the hostel owner, and the authorities where the law requires, without delay.",
      ],
    },
    {
      heading: "9. Children",
      blocks: [
        "Some students may be under 18. The hostel owner must have a parent's or guardian's verifiable consent before adding them, and we use their information only to run the hostel's HostelConnect: never for tracking, profiling or advertising.",
      ],
    },
    {
      heading: "10. Your rights",
      blocks: [
        `You may ask to see the information held about you, to have it corrected or deleted, and to name someone to act for you. Students should ask their hostel's owner first; owners, or students who get no answer, can write to ${CONTACT}. We will answer within 30 days. You may also complain to the Data Protection Board of India.`,
      ],
    },
    {
      heading: "11. Changes, and contact",
      blocks: [
        `If we change this policy in a way that matters, we will say so in the app before the change applies. Grievance officer: [name], ${CONTACT}.`,
      ],
    },
  ],
};
