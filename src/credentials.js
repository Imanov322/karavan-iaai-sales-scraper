/**
 * Resolves an account name (e.g. "Khorasan", "Ali") to IAAI credentials
 * stored in env vars.
 *
 * Env var format: IAAI_<NAME>_USER and IAAI_<NAME>_PASS, where <NAME> is
 * the uppercase account name.
 *
 * Example: account = "khorasan" → looks up IAAI_KHORASAN_USER / IAAI_KHORASAN_PASS.
 */
function resolveCredentials(account) {
  if (!account || typeof account !== "string") {
    throw new Error("account is required");
  }
  const key = account.trim().toUpperCase();
  const user = process.env[`IAAI_${key}_USER`];
  const pass = process.env[`IAAI_${key}_PASS`];
  if (!user || !pass) {
    throw new Error(
      `No IAAI credentials configured for account "${account}" ` +
        `(expected env vars IAAI_${key}_USER and IAAI_${key}_PASS).`,
    );
  }
  return { user, pass, accountKey: key };
}

module.exports = { resolveCredentials };
