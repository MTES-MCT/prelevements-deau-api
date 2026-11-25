ALTER TABLE "InstructorZone" ADD COLUMN "isDashboardDefault" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "InstructorZone_one_dashboard_default_per_instructor"
  ON "InstructorZone" ("instructorUserId") WHERE "isDashboardDefault";
