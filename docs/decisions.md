# Decisions and trade-offs

## 1. The problem decides the scope

HostelConnect is designed from the hostel owner's perspective. An owner should not have to deal with an unlimited number of complaints or spend unlimited time and attention on them. Each student can have at most 3 open complaints, raise at most 2 new complaints per day, and have only 1 open complaint per category. These limits protect the owner's time and attention; they do not make repairs any cheaper. They encourage students to report genuine issues while preventing unnecessary or repeated complaints. We chose structured complaint tracking instead of building another chat application. Students can report issues, but they cannot message each other or reply to complaints. The owner receives one daily digest to stay informed without being overwhelmed by notifications.

The trade-off is that students cannot discuss complaints publicly, and the owner must check the dashboard instead of receiving an alert for every complaint.

## 2. ₹0 a month on free tiers

My first priority is making HostelConnect available 24/7, so the owner and students can access it anytime and from anywhere without unnecessary downtime, glitches or errors.

The free tiers of Render, Supabase and GitHub Actions helped me build and deploy the project without monthly costs, but they have limitations: the server sleeps when idle, the database pauses after a period of inactivity, and scheduled jobs do not always run on time.

I am willing to pay for reliable hosting and database availability once real users depend on the application. Before adding more features, I want to ensure the website is consistently accessible.

Another equally important priority is data safety. Even if the website is hacked, the server crashes, or the application is accidentally deleted, the owner's hostel records must remain recoverable through separate encrypted backups (see Section 7).

## 3. No background process

We chose hourly scheduled jobs because we are using free hosting services, which naturally come with limitations. Keeping a continuously running background process would require more reliable, always-on hosting, which would increase costs. With our current approach, scheduled tasks may sometimes be delayed, but they still execute without requiring a continuously running server. Each job only does what is due at that moment and never repeats its work, so a late or extra run does no harm. If the application grows and users expect faster and more reliable execution, we can move to paid infrastructure.

## 4. Plain SQL; the database has the last word

We chose plain SQL with PostgreSQL and the pg library instead of an ORM because we wanted direct control over database operations and wanted to understand exactly what happens when data is stored or updated.

Admissions are controlled by the hostel owner, but we still need database-level protection. If two admission requests accidentally arrive at the same time for the same bed, application-level checks alone might not prevent both from succeeding. The database's unique constraint ensures that a bed cannot be assigned to two students simultaneously.

The trade-off is writing more SQL manually, but it gives us better visibility and control over database operations.

## 5. Security sized to the threat

My main security concern is students deliberately trying to hack or damage HostelConnect for fun, curiosity or revenge against the hostel owner. With AI tools, even students with limited technical knowledge may attempt unauthorized access. I am concerned about three risks, and the application protects against each of them through authentication, authorization, database restrictions and secure photo storage.

**Students accessing other students' private information.** Every request is checked for the user's role, and every student query is filtered by that student's own id. Asking for another student's record answers "not found", so ids cannot be probed. Complaint photos are kept in a private bucket and shown only through links that expire after 60 seconds, and the photos are deleted after 48 hours. Phone numbers never appear in logs, URLs or notification text.

**Someone gaining access to the owner's account.** Passwords are stored only as bcrypt hashes. After 10 failed login attempts in 15 minutes, further attempts are refused for a while. Temporary passwords must be changed at the first login. The login session is kept in a cookie that page scripts cannot read, and every change request must come from the app's own site.

**Someone deleting or damaging hostel records.** The app's database account cannot drop or truncate tables, and it cannot delete users, beds or stays at all. Database changes are made with a separate account that is not stored on the server. Every query uses parameters and every input is validated, so typed text cannot change a query. If something still goes wrong, the encrypted backups in Section 7 allow the records to be restored.

I understand that no application can guarantee protection against every possible attack. Our goal is to reduce realistic risks and protect sensitive hostel data. For example, there is no two-factor login for the owner and no content security policy yet.

## 6. Money stays outside the app

My decision was to keep payments outside HostelConnect to make the application free and simple to operate.

Students pay the owner directly using the UPI ID or QR code displayed in the app. The owner manually verifies the payment and marks the fee as paid.

This avoids payment gateway charges, integration complexity, payment failures, refund handling and storing sensitive financial information. It also keeps the owner in control of payments.

The trade-off is that payments cannot be verified automatically; the owner must confirm each payment manually.

## 7. Backups you don't need to trust

For me, the worst-case scenario is the hostel losing important records such as student details, accommodation history, fee records and complaints due to a server failure, accidental damage or a security incident.

I want to be able to recover the owner's data even if the application or its hosting environment becomes unavailable.

Nightly encrypted backups provide a separate copy of the database. Complaint photos are not included, since they are deleted after 48 hours anyway. Keeping them encrypted is especially important because the GitHub repository is public. Restoring into a separate scratch database first prevents an unverified backup from affecting live data.

I understand that nightly backups mean up to 24 hours of recent changes could be lost. I accept that trade-off for now. Losing the private encryption key would make every backup unusable, so protecting that key separately is essential.

Both restore drills passed on Day 10, which gives me confidence that the backups can actually be recovered, rather than simply assuming they work.

## 8. Not built yet

Since Day 10, the two improvements I ranked highest have been built and deployed:

- **Student password reset:** the owner can give a current student a new temporary password from their profile. It is shown once, and the student must change it at their next login.
- **Edit student details and monthly fees:** the owner can correct a student's details after admission. A new fee applies only to fees created after the change, so fees already listed keep their amount. The joining date cannot be changed, because the database does not allow a stay's start date to move; I left that out for now.

The second production user has also been checked: it was a test student, and it has been moved out.

What remains, in order of their impact on actual hostel operations:

1. **Content Security Policy (CSP):** Add this as an additional layer of browser-side security.
2. **PWA support:** This would make HostelConnect easier to access and use like an installable app on phones.
3. **Aadhaar:** I haven't decided whether this is necessary. I don't want to collect sensitive identity information without a clear operational reason.
4. **Editing the joining date:** This would need a database change and rules for fees that already exist, so I would only add it if it is actually needed.

These are planned improvements, not features that currently exist.

## How it was built

HostelConnect was developed through an iterative, step-by-step process. I made the architectural decisions, defined the requirements, selected the technology stack and decided the trade-offs based on the hostel's actual needs.

I used Claude as a coding assistant to scaffold the application, implement features and write tests. I reviewed the proposed changes, discussed implementation decisions, investigated failures and approved each step before moving forward.

Testing was an important part of the process. The project has 1,009 server tests and 317 client tests. New tests were not simply accepted because they passed. They were deliberately checked against planted bugs to confirm that they failed when the expected behaviour was broken. Afterward, the correct implementation was restored and the tests were run again.

Development was divided into manageable stages, with implementation, testing, verification and documentation handled incrementally. Decisions, corrections and progress were recorded in `docs/progress.md`.

The goal was not just to generate working code with AI, but to understand the system, verify its behaviour and build an application that could be maintained and improved.
