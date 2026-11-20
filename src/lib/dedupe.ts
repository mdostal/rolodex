// Dedup keys shared by Store.upsert() and the Google pull merge
// (findExistingMatch), so both agree on which existing card a contact matches.

/** Email dedup key: trimmed, lowercased; undefined when blank. */
export function normalizeEmail(email: string | null | undefined): string | undefined {
  const e = email?.trim().toLowerCase();
  return e ? e : undefined;
}

/** Phone dedup key, "E.164-ish": digits only, with an international `00`
 * prefix treated like `+`. Fewer than 7 digits is too short to be a
 * meaningful match key, so it yields undefined (no phone dedup). */
export function normalizePhone(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  let digits = phone.replace(/\D/g, "");
  if (!phone.trim().startsWith("+") && digits.startsWith("00")) digits = digits.slice(2);
  return digits.length >= 7 ? digits : undefined;
}

/** Org key for link targets and name+org candidate matching: trimmed,
 * lowercased, internal whitespace collapsed; undefined when blank. */
export function normalizeOrg(org: string | null | undefined): string | undefined {
  const o = org?.trim().toLowerCase().replace(/\s+/g, " ");
  return o ? o : undefined;
}

/** Name key for name+org candidate matching, same normalization as orgs. */
export const normalizeName = normalizeOrg;
