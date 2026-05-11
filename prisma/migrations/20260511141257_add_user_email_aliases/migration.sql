-- CreateTable
CREATE TABLE "UserEmailAlias" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserEmailAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserEmailAlias_email_key" ON "UserEmailAlias"("email");

-- CreateIndex
CREATE INDEX "UserEmailAlias_userId_idx" ON "UserEmailAlias"("userId");

-- AddForeignKey
ALTER TABLE "UserEmailAlias" ADD CONSTRAINT "UserEmailAlias_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "ensure_user_email_alias_not_primary"()
    RETURNS trigger AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "User"
        WHERE "email" = NEW."email"
    ) THEN
        RAISE EXCEPTION 'email already used as a primary user email'
            USING ERRCODE = '23505',
                CONSTRAINT = 'UserEmailAlias_email_not_primary';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "UserEmailAlias_check_email_not_primary"
    BEFORE INSERT OR UPDATE OF "email"
    ON "UserEmailAlias"
    FOR EACH ROW
EXECUTE FUNCTION "ensure_user_email_alias_not_primary"();

CREATE OR REPLACE FUNCTION "ensure_user_primary_email_not_alias"()
    RETURNS trigger AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "UserEmailAlias"
        WHERE "email" = NEW."email"
    ) THEN
        RAISE EXCEPTION 'email already used as a user alias'
            USING ERRCODE = '23505',
                CONSTRAINT = 'User_email_not_alias';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "User_check_email_not_alias"
    BEFORE INSERT OR UPDATE OF "email"
    ON "User"
    FOR EACH ROW
EXECUTE FUNCTION "ensure_user_primary_email_not_alias"();
