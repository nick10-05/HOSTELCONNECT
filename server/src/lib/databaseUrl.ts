// Checks a database URL before anything connects with it, so a pasting mistake gives a
// message that says what is wrong, not just "Invalid URL".
// Returns undefined when the URL looks right, or a description of the problem.
// The description never quotes the URL or any part of it: it ends up in logs.
export function databaseUrlProblem(value: string): string | undefined {
  const url = value.trim();
  if (url === "") return "is empty";
  if (/^["']|["']$/.test(url)) return "is wrapped in quotes; store the URL without them";
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(url)) {
    return "starts with a variable name and '='; store only the URL itself";
  }
  if (!/^postgres(ql)?:\/\//.test(url)) return "must start with postgres:// or postgresql://";
  if (/[<>]|\[YOUR-PASSWORD\]/i.test(url)) return "still contains a placeholder such as <HOST> or [YOUR-PASSWORD]";

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The usual cause: a raw # / or ? in the password ends the user:password part early.
    return (
      "is not a valid URL. If the password contains characters such as # / ? or @, " +
      "percent-encode it, or use a password of letters and digits only"
    );
  }

  if (!parsed.username) return "has no user name";
  if (!parsed.password) return "has no password";
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    return "contains a % that is not part of a %XX code; percent-encode the password";
  }
  if (!parsed.hostname) return "has no host";
  if (parsed.pathname.length <= 1) return "has no database name (it should end in /postgres or similar)";
  return undefined;
}
