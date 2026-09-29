CREATE TABLE "UserMonthlyActivity" (
    "month" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMonthlyActivity_pkey" PRIMARY KEY ("month", "userId"),
    CONSTRAINT "UserMonthlyActivity_month_check" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

CREATE INDEX "UserMonthlyActivity_userId_idx" ON "UserMonthlyActivity"("userId");

ALTER TABLE "UserMonthlyActivity" ADD CONSTRAINT "UserMonthlyActivity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UserActivityCollectionState" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserActivityCollectionState_pkey" PRIMARY KEY ("id")
);

-- Ne pas initialiser startedAt ici : le front peut être déployé plus tard.
