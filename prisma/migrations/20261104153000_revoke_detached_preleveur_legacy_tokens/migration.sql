-- Old tokens do not identify whether the login used the canonical email or
-- an alias. Require a fresh login when that canonical email is no longer
-- the explicit principal. Explicit aliases remain usable after reconnecting.
DELETE FROM "AuthToken" t USING "User" u, "Declarant" d
WHERE t."userId" = u.id AND d."userId" = u.id
  AND u.role = 'DECLARANT' AND d."declarantRole" = 'PRELEVEUR'
  AND (d.email IS NULL OR d.email IS DISTINCT FROM u.email) AND t."loginEmail" IS NULL;

DELETE FROM "SessionToken" t USING "User" u, "Declarant" d
WHERE t."userId" = u.id AND d."userId" = u.id
  AND u.role = 'DECLARANT' AND d."declarantRole" = 'PRELEVEUR'
  AND (d.email IS NULL OR d.email IS DISTINCT FROM u.email) AND t."loginEmail" IS NULL;

-- An outstanding activation link is another way to create a legacy session.
-- Preserve credentials and invalidate only the activation links for this scope.
DELETE FROM "PasswordActivation" t USING "User" u, "Declarant" d
WHERE t."userId" = u.id AND d."userId" = u.id
  AND u.role = 'DECLARANT' AND d."declarantRole" = 'PRELEVEUR'
  AND (d.email IS NULL OR d.email IS DISTINCT FROM u.email);
